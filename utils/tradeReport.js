import { exec } from "../db.js";
import { computePlayerValues } from "./calculations.js";
import { enrichWithKeeperValues } from "./keeperValues.js";

const KEEPER_SLOTS = 8;
const KEEPER_POOL = 96; // 8 keepers × 12 teams
const STARTER_COUNTS = { QB: 1, RB: 2, WR: 3, TE: 1 };

/**
 * Generate a weekly trade report analyzing keeper surplus/needs across all teams.
 * @param {string} leagueId
 * @param {number} [year] defaults to current year
 * @returns {Promise<string[]>} array of GroupMe-safe messages (each ≤1000 chars)
 */
export async function generateTradeReport(leagueId, year) {
  if (!year) year = new Date().getFullYear();

  // 1. Fetch rosters with owner names (join via owner_id → user_id)
  const rosters = await exec(
    `SELECT r.*, u.display_name
     FROM rosters r
     LEFT JOIN league_users u ON u.user_id = r.owner_id AND u.league_id = r.league_id
     WHERE r.league_id = $1`,
    [leagueId],
  );

  // 2. Fetch all rostered players
  const allPlayerIds = [
    ...new Set(rosters.flatMap((r) => r.player_ids ?? [])),
  ];
  if (!allPlayerIds.length) return ["No rosters found for trade report."];

  const players = await exec(
    `SELECT * FROM vw_players WHERE id = ANY($1::text[]) AND year = $2 AND position IN ('QB','RB','WR','TE')`,
    [allPlayerIds, year],
  );

  // 3. Compute values using existing pipeline
  const valued = enrichWithKeeperValues(computePlayerValues(players));
  const playerMap = Object.fromEntries(valued.map((p) => [p.id, p]));

  // 4. Determine keeper-worthy (top 96 by bfbValue)
  const sorted = [...valued].sort((a, b) => (b.bfbValue ?? 0) - (a.bfbValue ?? 0));
  const keeperWorthyIds = new Set(sorted.slice(0, KEEPER_POOL).map((p) => p.id));

  // 5. Per-team analysis
  const teams = rosters.map((roster) => {
    const rosterPlayers = (roster.player_ids ?? [])
      .map((id) => playerMap[id])
      .filter(Boolean)
      .sort((a, b) => (b.bfbValue ?? 0) - (a.bfbValue ?? 0));

    const keeperWorthy = rosterPlayers.filter((p) => keeperWorthyIds.has(p.id));
    const surplus = keeperWorthy.length > KEEPER_SLOTS
      ? keeperWorthy.slice(KEEPER_SLOTS) // lowest-valued keeper-worthy players are trade candidates
      : [];

    // Positional needs (only for teams with <8 keepers)
    const needs = [];
    if (keeperWorthy.length < KEEPER_SLOTS) {
      const byPos = {};
      for (const pos of Object.keys(STARTER_COUNTS)) {
        byPos[pos] = keeperWorthy.filter((p) => p.position === pos);
      }
      for (const [pos, count] of Object.entries(STARTER_COUNTS)) {
        if ((byPos[pos]?.length ?? 0) < count) {
          needs.push(pos);
        }
      }
    }

    return {
      name: roster.display_name || `Team ${roster.roster_id}`,
      rosterId: roster.roster_id,
      keeperCount: keeperWorthy.length,
      surplus,
      needs,
    };
  });

  const surplusTeams = teams.filter((t) => t.surplus.length > 0);
  const needTeams = teams.filter((t) => t.needs.length > 0);

  // No trade opportunities
  if (surplusTeams.length === 0 && needTeams.length === 0) {
    return ["BFB Weekly Trade Report: All teams have 8 or fewer keeper-worthy players - no obvious trade opportunities this week."];
  }

  // 6. Match candidates to needy teams (best fit per player)
  const matches = [];
  const matchedPlayers = new Set();
  for (const team of surplusTeams) {
    for (const player of team.surplus) {
      const playerName = player.full_name || player.player_name || "Unknown";
      if (matchedPlayers.has(playerName)) continue;
      // Find the neediest team for this position (fewest keepers)
      const bestFit = needTeams
        .filter((t) => t.needs.includes(player.position))
        .sort((a, b) => a.keeperCount - b.keeperCount)[0];
      if (bestFit) {
        matchedPlayers.add(playerName);
        matches.push({
          player: playerName,
          position: player.position,
          from: team.name,
          to: bestFit.name,
          value: player.bfbValue ?? 0,
        });
      }
    }
  }
  matches.sort((a, b) => b.value - a.value);

  // 7. Format messages
  const messages = [];

  // Message 1: Surplus teams
  let msg1 = "BFB WEEKLY TRADE REPORT\n\nSurplus keeper-worthy players:";
  for (const team of surplusTeams) {
    const players = team.surplus
      .map((p) => `${p.full_name || p.player_name} (${p.position})`)
      .join(", ");
    msg1 += `\n- ${team.name} (${team.keeperCount} keepers): ${players}`;
  }
  messages.push(msg1);

  // Message 2: Needs + matches
  let msg2 = "";
  if (needTeams.length > 0) {
    msg2 += "Teams needing keepers:";
    for (const team of needTeams) {
      msg2 += `\n- ${team.name} (${team.keeperCount} keepers): needs ${team.needs.join(", ")}`;
    }
  }

  if (matches.length > 0) {
    msg2 += "\n\nTrade fits:";
    for (const m of matches.slice(0, 8)) {
      msg2 += `\n- ${m.player} (${m.position}) ${m.from} -> ${m.to}`;
    }
  }

  if (msg2) {
    // Split if over 1000 chars
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
