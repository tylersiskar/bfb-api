import { getRostersWithOwners, getSkillPlayersByIds } from "../db.js";
import { enrichPlayers, getKeeperWorthyIds, fetchSleeperKeepers } from "./league.js";

const KEEPER_SLOTS = 8;
const STARTER_COUNTS = { QB: 1, RB: 2, WR: 3, TE: 1 };

/**
 * Generate a weekly trade report analyzing keeper surplus/needs across all teams.
 * Uses set keepers from Sleeper when available, otherwise projects by value.
 * @param {string} leagueId
 * @param {number} [year] defaults to current year
 * @returns {Promise<string[]>} array of GroupMe-safe messages (each ≤1000 chars)
 */
export async function generateTradeReport(leagueId, year) {
  if (!year) year = new Date().getFullYear();

  // 1. Fetch rosters with owner names
  const rosters = await getRostersWithOwners(leagueId);

  // 2. Fetch all rostered players
  const allPlayerIds = [
    ...new Set(rosters.flatMap((r) => r.player_ids ?? [])),
  ];
  if (!allPlayerIds.length) return ["No rosters found for trade report."];

  const players = await getSkillPlayersByIds(allPlayerIds, year);

  // 3. Compute values
  const { withValues: valued, playerMap } = enrichPlayers(players);

  // 4. Fetch Sleeper keepers
  const sleeperKeepers = await fetchSleeperKeepers(leagueId);

  // 5. Determine keeper-worthy pool (top 96 by bfbValue)
  const keeperWorthyIds = getKeeperWorthyIds(valued);

  // 6. Per-team analysis (same logic as tradeController.buildTeamAnalysis)
  const teams = rosters.map((roster) => {
    const rosterPlayers = (roster.player_ids ?? [])
      .map((id) => playerMap[id])
      .filter(Boolean)
      .sort((a, b) => (b.bfbValue ?? 0) - (a.bfbValue ?? 0));

    const setKeeperIds = sleeperKeepers[roster.roster_id];
    let keeperWorthy;
    let surplus;

    const resolvedKeepers = setKeeperIds
      ? setKeeperIds.map((id) => playerMap[id]).filter(Boolean)
      : [];

    if (resolvedKeepers.length >= KEEPER_SLOTS) {
      keeperWorthy = resolvedKeepers
        .sort((a, b) => (b.bfbValue ?? 0) - (a.bfbValue ?? 0))
        .slice(0, KEEPER_SLOTS);
      const keeperIdSet = new Set(keeperWorthy.map((p) => p.id));
      const worstKeeperVal = keeperWorthy[keeperWorthy.length - 1]?.bfbValue ?? 0;
      surplus = rosterPlayers
        .filter((p) => !keeperIdSet.has(p.id) && keeperWorthyIds.has(p.id) && (p.bfbValue ?? 0) < worstKeeperVal * 0.95);
    } else {
      const allKeeperWorthy = rosterPlayers.filter((p) => keeperWorthyIds.has(p.id));
      keeperWorthy = allKeeperWorthy.slice(0, KEEPER_SLOTS);
      const projectedKeeperIds = new Set(keeperWorthy.map((p) => p.id));
      const worstKeeperVal = keeperWorthy[keeperWorthy.length - 1]?.bfbValue ?? 0;
      surplus = rosterPlayers
        .filter((p) => !projectedKeeperIds.has(p.id) && keeperWorthyIds.has(p.id) && (p.bfbValue ?? 0) < worstKeeperVal * 0.95);
    }

    const byPos = {};
    for (const pos of Object.keys(STARTER_COUNTS)) {
      byPos[pos] = keeperWorthy.filter((p) => p.position === pos);
    }
    const needs = [];
    for (const [pos, count] of Object.entries(STARTER_COUNTS)) {
      if ((byPos[pos]?.length ?? 0) < count) needs.push(pos);
    }

    return {
      name: roster.display_name || `Team ${roster.roster_id}`,
      rosterId: roster.roster_id,
      keeperCount: keeperWorthy.length,
      keeperWorthy,
      surplus,
      needs,
      keepersSet: resolvedKeepers.length >= KEEPER_SLOTS,
    };
  });

  const surplusTeams = teams.filter((t) => t.surplus.length > 0);
  const needTeams = teams.filter((t) => t.needs.length > 0);

  if (surplusTeams.length === 0 && needTeams.length === 0) {
    return ["BFB Weekly Trade Report: All teams have 8 or fewer keeper-worthy players - no obvious trade opportunities this week."];
  }

  // 7. Match surplus players to teams that need the position AND the player cracks their top 8
  const matches = [];
  const matchedPlayers = new Set();
  for (const team of surplusTeams) {
    for (const player of team.surplus) {
      const playerName = player.full_name || player.player_name || "Unknown";
      if (matchedPlayers.has(playerName)) continue;

      const playerVal = player.bfbValue ?? 0;

      // QB/TE: only match to teams that need the position
      // WR/RB: match to any team where the player cracks their top 8
      const isScarcityPos = player.position === "QB" || player.position === "TE";
      const candidates = isScarcityPos ? needTeams : teams;
      const fits = candidates
        .filter((t) => {
          if (t.rosterId === team.rosterId) return false;
          if (isScarcityPos && !t.needs.includes(player.position)) return false;
          const teamFloor = t.keeperWorthy.length >= KEEPER_SLOTS
            ? t.keeperWorthy[KEEPER_SLOTS - 1].bfbValue ?? 0
            : 0;
          return playerVal > teamFloor || t.keeperWorthy.length < KEEPER_SLOTS;
        })
        .sort((a, b) => a.keeperCount - b.keeperCount);

      if (fits.length > 0) {
        matchedPlayers.add(playerName);
        matches.push({
          player: playerName,
          position: player.position,
          from: team.name,
          to: fits[0].name,
          value: playerVal,
        });
      }
    }
  }
  matches.sort((a, b) => b.value - a.value);

  // 8. Format messages
  const messages = [];

  let msg1 = "BFB WEEKLY TRADE REPORT\n\nSurplus keeper-worthy players:";
  for (const team of surplusTeams) {
    const players = team.surplus
      .map((p) => `${p.full_name || p.player_name} (${p.position})`)
      .join(", ");
    msg1 += `\n- ${team.name}${team.keepersSet ? "" : "*"}: ${players}`;
  }
  if (surplusTeams.some((t) => !t.keepersSet)) {
    msg1 += "\n\n* projected keepers (not yet set)";
  }
  messages.push(msg1);

  let msg2 = "";
  if (needTeams.length > 0) {
    msg2 += "Teams needing keepers:";
    for (const team of needTeams) {
      msg2 += `\n- ${team.name}: needs ${team.needs.join(", ")}`;
    }
  }

  if (matches.length > 0) {
    msg2 += "\n\nTrade fits:";
    for (const m of matches.slice(0, 8)) {
      msg2 += `\n- ${m.player} (${m.position}) ${m.from} -> ${m.to}`;
    }
  }

  if (msg2) {
    if (msg2.length > 950) {
      const lines = msg2.split("\n");
      let chunk = "";
      for (const line of lines) {
        if (chunk.length + line.length + 1 > 950) {
          messages.push(chunk.trim());
          chunk = "";
        }
        chunk += line + "\n";
      }
      if (chunk.trim()) messages.push(chunk.trim());
    } else {
      messages.push(msg2);
    }
  }

  return messages;
}
