import { getRostersWithOwners, getPlayersByIds, getSkillPlayersByIds, getDraftPicksByLeague } from "../db.js";
import {
  getPickValue,
  calculateTradeValue,
  applyEliteCurve,
  applyConsolidationDiscount,
} from "../utils/calculations.js";
import { getPickSlotMap } from "../utils/pickSlots.js";
import { runTradeBridge } from "../utils/pythonBridge.js";
import { enrichPlayers, getKeeperWorthyIds, fetchSleeperKeepers } from "../utils/league.js";

const STARTER_COUNTS = { QB: 1, RB: 2, WR: 3, TE: 1 };

/**
 * Build a roster list (player dicts with weekly_avg + bfb_value) from DB rows.
 * This is the format the Python trade calculator expects.
 */
function toTradeRoster(players) {
  return players.map((p) => ({
    player_name: p.full_name || p.player_name || "Unknown",
    position: p.position || "UNK",
    weekly_avg: p.pts_half_ppr && p.gms_active
      ? Math.round((p.pts_half_ppr / Math.max(p.gms_active, 1)) * 10) / 10
      : 0,
    age: p.age ?? p.years_exp ? 22 + (p.years_exp ?? 0) : 27,
    bfb_value: p.bfbValue ?? 0,
  }));
}

export const calculateTrade = async (req, res) => {
  try {
    const { side_a, side_b, league_id } = req.body;
    const year = parseInt(req.query.year) || new Date().getFullYear();

    const allPlayerIds = [...(side_a.players ?? []), ...(side_b.players ?? [])];
    const players = await getPlayersByIds(allPlayerIds, year);

    const { withValues, playerMap } = enrichPlayers(players);

    // Pick slot map — uses real draft order (offseason) or standings (in-season)
    const { rosterToSlot } = league_id
      ? await getPickSlotMap(league_id)
      : { rosterToSlot: {} };

    const sidePickValue = (picks) =>
      (picks ?? []).reduce((sum, pick) => {
        // FE sends roster_id = original_roster_id — pick slot is determined
        // by the original team's standing, not who currently holds the pick
        const slot = rosterToSlot[pick.roster_id] ?? 6;
        return sum + getPickValue(pick.round, slot, pick.years_out ?? 0);
      }, 0);

    // Build roster arrays for each side
    const aPlayerObjs = (side_a.players ?? []).map((id) => playerMap[id]).filter(Boolean);
    const bPlayerObjs = (side_b.players ?? []).map((id) => playerMap[id]).filter(Boolean);

    const aGiveNames = aPlayerObjs.map((p) => p.full_name || p.player_name);
    const bGiveNames = bPlayerObjs.map((p) => p.full_name || p.player_name);

    // If we have rosters for both sides, run full Python analysis
    let advancedAnalysis = null;
    if (league_id && side_a.roster_id && side_b.roster_id) {
      const rosters = await getRostersWithOwners(league_id);
      const aRoster = rosters.find((r) => r.roster_id === parseInt(side_a.roster_id));
      const bRoster = rosters.find((r) => r.roster_id === parseInt(side_b.roster_id));

      if (aRoster && bRoster) {
        const aAllIds = aRoster.player_ids ?? [];
        const bAllIds = bRoster.player_ids ?? [];
        const allRosterIds = [...new Set([...aAllIds, ...bAllIds])];

        const rosterPlayers = await getPlayersByIds(allRosterIds, year);
        const { playerMap: rosterPlayerMap } = enrichPlayers(rosterPlayers);

        const aFullRoster = toTradeRoster(aAllIds.map((id) => rosterPlayerMap[id]).filter(Boolean));
        const bFullRoster = toTradeRoster(bAllIds.map((id) => rosterPlayerMap[id]).filter(Boolean));

        try {
          advancedAnalysis = await runTradeBridge({
            action: "evaluate",
            team_a_roster: aFullRoster,
            team_b_roster: bFullRoster,
            a_gives: aGiveNames,
            b_gives: bGiveNames,
            team_a_name: side_a.name || "Side A",
            team_b_name: side_b.name || "Side B",
            a_picks: (side_a.picks ?? []).map((p) => ({
              round: p.round,
              slot: rosterToSlot[p.roster_id] ?? 6,
              years_out: p.years_out ?? 0,
            })),
            b_picks: (side_b.picks ?? []).map((p) => ({
              round: p.round,
              slot: rosterToSlot[p.roster_id] ?? 6,
              years_out: p.years_out ?? 0,
            })),
          });
        } catch (err) {
          console.warn("Python trade bridge failed, using JS fallback:", err.message);
        }
      }
    }

    // ── JS-based value calculation (always runs as baseline) ──

    const tradeValue = (id) => playerMap[id]?.bfbValue ?? 0;
    const sortedValues = (ids) => ids.map(tradeValue).sort((a, b) => b - a);

    const aPlayerValues = sortedValues(side_a.players ?? []);
    const bPlayerValues = sortedValues(side_b.players ?? []);

    const aPickVal = sidePickValue(side_a.picks);
    const bPickVal = sidePickValue(side_b.picks);

    const bTotalAssets = (side_b.players ?? []).length + (side_b.picks ?? []).length;
    const aTotalAssets = (side_a.players ?? []).length + (side_a.picks ?? []).length;

    const aSide = calculateTradeValue(aPlayerValues, aPickVal, bTotalAssets);
    const bSide = calculateTradeValue(bPlayerValues, bPickVal, aTotalAssets);

    // Fairness: 50 = perfectly fair, >50 = side A giving more, <50 = side B giving more
    const totalValue = aSide.total + bSide.total || 1;
    const fairness = Math.round((aSide.total / totalValue) * 100);

    const margin =
      Math.abs(fairness - 50) < 5
        ? "even"
        : Math.abs(fairness - 50) < 12
          ? "slight"
          : Math.abs(fairness - 50) < 22
            ? "moderate"
            : "significant";

    // Side giving more value loses — the other side wins
    const winner = fairness > 52 ? "side_b" : fairness < 48 ? "side_a" : "even";

    const response = {
      fairness,
      winner,
      margin,
      breakdown: {
        side_a_value: aSide.total,
        side_b_value: bSide.total,
        side_a_raw_value: aSide.rawTotal,
        side_b_raw_value: bSide.rawTotal,
        side_a_picks_value: aPickVal,
        side_b_picks_value: bPickVal,
        side_a_tax: aSide.taxApplied ? aSide.taxRate : 0,
        side_b_tax: bSide.taxApplied ? bSide.taxRate : 0,
      },
      players: withValues.map((p) => ({
        id: p.id,
        full_name: p.full_name,
        position: p.position,
        bfbValue: p.bfbValue,
        tradeValue: applyEliteCurve(p.bfbValue ?? 0, Math.max(...aPlayerValues, ...bPlayerValues, 1)),
        keeper_value: p.keeper_value ?? null,
        longevity_score: p.longevity_score ?? null,
      })),
    };

    if (advancedAnalysis && !advancedAnalysis.error) {
      response.advanced = advancedAnalysis;
    }

    res.json(response);
  } catch (error) {
    console.error("Error calculating trade:", error);
    res.status(500).send({ error, message: "Internal Server Error" });
  }
};

const KEEPER_SLOTS = 8;
const KEEPER_POOL = 96; // 8 keepers × 12 teams

// ── Shared trade helpers ─────────────────────────────────────────────────

// What would a team's 8th-best keeper value be if a player is removed?
function getPostTradeFloor(team, removedPlayer) {
  const remaining = team.keeperWorthy
    .filter((p) => p.id !== removedPlayer.id)
    .sort((a, b) => (b.bfbValue ?? 0) - (a.bfbValue ?? 0));
  return remaining.length >= KEEPER_SLOTS
    ? remaining[KEEPER_SLOTS - 1].bfbValue ?? 0
    : 0;
}

// Would a team's keeper core improve if they trade away `give` and receive `incoming`?
function tradeImprovesTeam(team, give, incoming) {
  const giveArr = Array.isArray(give) ? give : [give];
  const incomingArr = Array.isArray(incoming) ? incoming : [incoming];
  const giveIds = new Set(giveArr.map((p) => p.id));
  const remaining = team.players
    .filter((p) => !giveIds.has(p.id))
    .concat(incomingArr)
    .sort((a, b) => (b.bfbValue ?? 0) - (a.bfbValue ?? 0));
  const newTop8Value = remaining.slice(0, KEEPER_SLOTS).reduce((s, p) => s + (p.bfbValue ?? 0), 0);
  const oldTop8Value = [...team.players]
    .sort((a, b) => (b.bfbValue ?? 0) - (a.bfbValue ?? 0))
    .slice(0, KEEPER_SLOTS)
    .reduce((s, p) => s + (p.bfbValue ?? 0), 0);
  return newTop8Value >= oldTop8Value;
}

// Get players a team would rationally trade for an incoming player
function getTradeablePlayers(team, incomingPlayer) {
  return team.players.filter((p) => {
    if (p.id === incomingPlayer.id) return false;
    return tradeImprovesTeam(team, p, incomingPlayer);
  });
}

// Build per-team analysis from rosters + playerMap + keeperWorthyIds
// surplusPoolIds: top-120 pool for identifying surplus players (defaults to keeperWorthyIds if not provided)
function buildTeamAnalysis(rosters, playerMap, keeperWorthyIds, sleeperKeepers = {}, surplusPoolIds = keeperWorthyIds) {
  // Global median keeper value across all keeper-worthy players — used for upgrade need detection
  const allKeeperWorthyPlayers = [...keeperWorthyIds].map((id) => playerMap[id]).filter(Boolean);
  const globalMedianVal = allKeeperWorthyPlayers.length > 0
    ? (allKeeperWorthyPlayers.sort((a, b) => (b.bfbValue ?? 0) - (a.bfbValue ?? 0))[Math.floor(allKeeperWorthyPlayers.length / 2)]?.bfbValue ?? 0)
    : 0;

  return rosters.map((roster) => {
    const rosterPlayers = (roster.player_ids ?? [])
      .map((id) => playerMap[id])
      .filter(Boolean)
      .sort((a, b) => (b.bfbValue ?? 0) - (a.bfbValue ?? 0));

    // Use set keepers from Sleeper if available, otherwise project top 8 by value
    const setKeeperIds = sleeperKeepers[roster.roster_id];
    let keeperWorthy;
    let surplus;
    // Only trust set keepers if all 8 resolve to valid players (otherwise stale/outdated)
    const resolvedKeepers = setKeeperIds
      ? setKeeperIds.map((id) => playerMap[id]).filter(Boolean)
      : [];
    if (resolvedKeepers.length >= KEEPER_SLOTS) {
      keeperWorthy = resolvedKeepers
        .sort((a, b) => (b.bfbValue ?? 0) - (a.bfbValue ?? 0))
        .slice(0, KEEPER_SLOTS);
      // Surplus = top-120 players not in keeper core AND meaningfully below worst keeper
      const keeperIdSet = new Set(keeperWorthy.map((p) => p.id));
      const worstKeeperVal = keeperWorthy[keeperWorthy.length - 1]?.bfbValue ?? 0;
      surplus = rosterPlayers
        .filter((p) => !keeperIdSet.has(p.id) && surplusPoolIds.has(p.id) && (p.bfbValue ?? 0) > 0 && (p.bfbValue ?? 0) < worstKeeperVal * 0.95);
    } else {
      // No keepers set — project top 8 by value, then check rest of roster
      const allKeeperWorthyOnRoster = rosterPlayers.filter((p) => keeperWorthyIds.has(p.id));
      keeperWorthy = allKeeperWorthyOnRoster.slice(0, KEEPER_SLOTS);
      const projectedKeeperIds = new Set(keeperWorthy.map((p) => p.id));
      const worstKeeperVal = keeperWorthy[keeperWorthy.length - 1]?.bfbValue ?? 0;
      surplus = rosterPlayers
        .filter((p) => !projectedKeeperIds.has(p.id) && surplusPoolIds.has(p.id) && (p.bfbValue ?? 0) > 0 && (p.bfbValue ?? 0) < worstKeeperVal * 0.95);
    }

    const byPos = {};
    for (const pos of Object.keys(STARTER_COUNTS)) {
      byPos[pos] = keeperWorthy.filter((p) => p.position === pos);
    }

    // Tiered needs detection:
    // criticalNeeds = missing starters entirely at a position
    // upgradeNeeds  = has starters but all are below-average keeper value
    const criticalNeeds = [];
    const upgradeNeeds = [];
    for (const [pos, count] of Object.entries(STARTER_COUNTS)) {
      const posPlayers = byPos[pos] ?? [];
      if (posPlayers.length === 0 || posPlayers.length < count) {
        criticalNeeds.push(pos);
      } else {
        const posAvg = posPlayers.reduce((s, p) => s + (p.bfbValue ?? 0), 0) / posPlayers.length;
        if (posAvg < globalMedianVal * 0.85) upgradeNeeds.push(pos);
      }
    }
    // backward-compat union
    const needs = [...new Set([...criticalNeeds, ...upgradeNeeds])];

    // Team mode based on win record: contend (6+ wins), rebuild (<4 wins), neutral otherwise
    const wins = roster.wins ?? 0;
    const teamMode = wins >= 6 ? "contend" : wins < 4 ? "rebuild" : "neutral";

    return {
      roster_id: roster.roster_id,
      display_name: roster.display_name || `Team ${roster.roster_id}`,
      players: rosterPlayers,
      keeperWorthy,
      surplus,
      needs,
      criticalNeeds,
      upgradeNeeds,
      teamMode,
      byPos,
      keepersSet: !!setKeeperIds,
    };
  });
}

export const findDeals = async (req, res) => {
  try {
    const { player_id, pick_id, roster_id, league_id, deal_pref } = req.body;
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const isPickTarget = !!pick_id;

    if ((!player_id && !pick_id) || !roster_id || !league_id) {
      return res.status(400).json({ message: "player_id or pick_id, plus roster_id and league_id are required" });
    }

    // 1. Fetch rosters with owner names
    const rosters = await getRostersWithOwners(league_id);

    const myRoster = rosters.find((r) => r.roster_id === parseInt(roster_id));
    if (!myRoster) return res.status(404).json({ message: "Roster not found" });

    // 2. Fetch + enrich all rostered players
    const allPlayerIds = [...new Set(rosters.flatMap((r) => r.player_ids ?? []))];
    const players = await getSkillPlayersByIds(allPlayerIds, year);

    const { withValues, playerMap } = enrichPlayers(players);

    // 3. Keeper-worthy pool (top 96 by bfbValue) + surplus pool (top 120)
    const keeperWorthyIds = getKeeperWorthyIds(withValues);
    const surplusPoolIds = getKeeperWorthyIds(withValues, 120);

    // 4. Build per-team analysis
    const teams = buildTeamAnalysis(rosters, playerMap, keeperWorthyIds, {}, surplusPoolIds);

    const myTeam = teams.find((t) => t.roster_id === parseInt(roster_id));

    // 5. Pick slot map for valuing picks
    const [{ rosterToSlot }, draftPicks] = await Promise.all([
      getPickSlotMap(league_id),
      getDraftPicksByLeague(league_id),
    ]);

    // Pick value using the perceived-value curve (no separate keeper discount needed)
    // isRebuilding: suppresses future-pick depreciation for teams in rebuild mode (see teamMode)
    const rawPickValue = (pick, isRebuilding = false) =>
      getPickValue(pick.round, rosterToSlot[pick.original_roster_id] ?? 6, pick.season > year ? 1 : 0, "mid", isRebuilding);

    // ── PICK TARGET: deal generation for acquiring/selling a draft pick ──
    if (isPickTarget) {
      const targetPick = draftPicks.find((p) =>
        p.season === pick_id.season &&
        p.round === pick_id.round &&
        p.original_roster_id === pick_id.original_roster_id,
      );
      if (!targetPick) return res.status(404).json({ message: "Pick not found" });

      const targetPickFormatted = formatPick(targetPick, rosterToSlot);
      const targetValue = targetPickFormatted.pick_value;
      const pickOwnerRosterId = targetPick.current_roster_id;
      const isSelling = pickOwnerRosterId === parseInt(roster_id);

      const deals = [];

      if (isSelling) {
        // ── SELLING OUR PICK: find teams that want it ──
        // My keeper floor doesn't change (not losing a player)
        const myCurrentFloor = myTeam.keeperWorthy.length >= KEEPER_SLOTS
          ? myTeam.keeperWorthy[KEEPER_SLOTS - 1].bfbValue ?? 0
          : 0;

        for (const team of teams) {
          if (team.roster_id === parseInt(roster_id)) continue;

          // For picks (especially 1st rounders), consider ALL players on a team —
          // not just surplus. Teams will trade non-core players for premium picks.
          const teamPlayers = team.players ?? [];

          // 1. Pick for Player (1-for-1)
          const p4pCandidates = teamPlayers
            .filter((p) => {
              const val = p.bfbValue ?? 0;
              const inRange = val >= targetValue * 0.65 && val <= targetValue * 1.35;
              const wouldKeep = val > myCurrentFloor;
              // The other team should be willing to give this player up —
              // player should NOT be in their top 4 keepers (core untouchables)
              const isCore = team.keeperWorthy.slice(0, 4).some((k) => k.id === p.id);
              return inRange && wouldKeep && !isCore;
            })
            .sort((a, b) => {
              const aFills = myTeam.needs.includes(a.position) ? 0 : 1;
              const bFills = myTeam.needs.includes(b.position) ? 0 : 1;
              if (aFills !== bFills) return aFills - bFills;
              return Math.abs((a.bfbValue ?? 0) - targetValue) - Math.abs((b.bfbValue ?? 0) - targetValue);
            });

          if (p4pCandidates.length > 0) {
            const candidate = p4pCandidates[0];
            const fairness = computeFairness(
              [], targetValue, 1,
              [candidate.bfbValue ?? 0], 0, 1,
            );
            deals.push({
              target_team: { roster_id: team.roster_id, display_name: team.display_name },
              type: "pick_for_player",
              give: { players: [], picks: [targetPickFormatted] },
              receive: { players: [formatPlayer(candidate)], picks: [] },
              fairness,
              rationale: `Your pick for ${candidate.position}${myTeam.needs.includes(candidate.position) ? " (fills need)" : ""} from ${team.display_name}`,
            });
          }

          // 2. Pick for Player + Picks
          const lowerCandidates = teamPlayers
            .filter((p) => {
              const val = p.bfbValue ?? 0;
              const wouldKeep = val > myCurrentFloor;
              const isCore = team.keeperWorthy.slice(0, 4).some((k) => k.id === p.id);
              return val >= targetValue * 0.4 && val < targetValue * 0.75 && wouldKeep && !isCore;
            })
            .sort((a, b) => (b.bfbValue ?? 0) - (a.bfbValue ?? 0));

          const teamPicks = draftPicks.filter((p) => p.current_roster_id === team.roster_id);
          if (lowerCandidates.length > 0 && teamPicks.length > 0) {
            const basePlayer = lowerCandidates[0];
            const gap = targetValue - (basePlayer.bfbValue ?? 0);
            const valuedPicks = teamPicks
              .map((p) => ({ ...p, pick_value: rawPickValue(p) }))
              .sort((a, b) => b.pick_value - a.pick_value);

            let picksToInclude = [];
            let pickTotal = 0;
            for (const pick of valuedPicks) {
              if (pickTotal >= gap * 1.1) break;
              picksToInclude.push(pick);
              pickTotal += pick.pick_value;
              if (picksToInclude.length >= 2) break;
            }

            const discountedPickTotal = applyConsolidationDiscount(pickTotal, picksToInclude.length);
            if (discountedPickTotal >= gap * 0.6) {
              const fairness = computeFairness(
                [], targetValue, 1 + picksToInclude.length,
                [basePlayer.bfbValue ?? 0], pickTotal, 1,
              );
              deals.push({
                target_team: { roster_id: team.roster_id, display_name: team.display_name },
                type: "player_plus_picks",
                give: { players: [], picks: [targetPickFormatted] },
                receive: {
                  players: [formatPlayer(basePlayer)],
                  picks: picksToInclude.map((p) => formatPick(p, rosterToSlot)),
                },
                fairness,
                rationale: `${basePlayer.position} + pick${picksToInclude.length > 1 ? "s" : ""} from ${team.display_name} for your pick`,
              });
            }
          }

          // 3. Pick for Multiple Players (2-for-1)
          const multiCandidates = teamPlayers
            .filter((p) => {
              const isCore = team.keeperWorthy.slice(0, 4).some((k) => k.id === p.id);
              return (p.bfbValue ?? 0) >= targetValue * 0.25 && !isCore;
            })
            .slice(0, 6);

          if (multiCandidates.length >= 2) {
            for (let i = 0; i < multiCandidates.length; i++) {
              for (let j = i + 1; j < multiCandidates.length; j++) {
                const p1 = multiCandidates[i];
                const p2 = multiCandidates[j];
                const comboValue = (p1.bfbValue ?? 0) + (p2.bfbValue ?? 0);
                const eitherKeepable = (p1.bfbValue ?? 0) > myCurrentFloor || (p2.bfbValue ?? 0) > myCurrentFloor;

                if (comboValue >= targetValue * 0.85 && comboValue <= targetValue * 1.6 && eitherKeepable) {
                  const fairness = computeFairness(
                    [], targetValue, 2,
                    [(p1.bfbValue ?? 0), (p2.bfbValue ?? 0)].sort((a, b) => b - a), 0, 1,
                  );
                  deals.push({
                    target_team: { roster_id: team.roster_id, display_name: team.display_name },
                    type: "multi_player",
                    give: { players: [], picks: [targetPickFormatted] },
                    receive: { players: [formatPlayer(p1), formatPlayer(p2)], picks: [] },
                    fairness,
                    rationale: `2-for-1: ${p1.position} + ${p2.position} from ${team.display_name} for your pick`,
                  });
                  break;
                }
              }
              if (deals.filter((d) => d.target_team.roster_id === team.roster_id && d.type === "multi_player").length > 0) break;
            }
          }

          // 4. Picks-only swap: trade your pick for their picks
          if (teamPicks.length > 0) {
            const valuedTeamPicks = teamPicks
              .map((p) => ({ ...p, pick_value: rawPickValue(p) }))
              .filter((p) => p.pick_value < targetValue) // only accept lesser picks that combine to match
              .sort((a, b) => b.pick_value - a.pick_value);

            let swapPicks = [];
            let swapTotal = 0;
            for (const pick of valuedTeamPicks) {
              if (swapTotal >= targetValue * 0.9) break;
              swapPicks.push(pick);
              swapTotal += pick.pick_value;
              if (swapPicks.length >= 3) break;
            }

            // Apply consolidation discount — trading up always costs more than raw sum
            const discountedSwap = applyConsolidationDiscount(swapTotal, swapPicks.length);
            if (swapPicks.length >= 2 && discountedSwap >= targetValue * 0.80) {
              const fairness = computeFairness(
                [], targetValue, swapPicks.length,
                [], swapTotal, 1,
              );
              deals.push({
                target_team: { roster_id: team.roster_id, display_name: team.display_name },
                type: "picks_only",
                give: { players: [], picks: [targetPickFormatted] },
                receive: {
                  players: [],
                  picks: swapPicks.map((p) => formatPick(p, rosterToSlot)),
                },
                fairness,
                rationale: `Trade down: ${swapPicks.length} picks from ${team.display_name} for your premium pick`,
              });
            }
          }
        }
      } else {
        // ── BUYING: find what we can offer to acquire this pick ──
        const sellerTeam = teams.find((t) => t.roster_id === pickOwnerRosterId);
        if (!sellerTeam) return res.json({ pick: targetPickFormatted, target_type: "pick", team_needs: myTeam.needs, deals: [] });

        // Players I could rationally offer — giving them away doesn't tank my keepers
        const myTradeable = myTeam.players.filter((p) => {
          // Would my top-8 value survive losing this player?
          const remaining = myTeam.players
            .filter((x) => x.id !== p.id)
            .sort((a, b) => (b.bfbValue ?? 0) - (a.bfbValue ?? 0));
          const newTop8 = remaining.slice(0, KEEPER_SLOTS).reduce((s, x) => s + (x.bfbValue ?? 0), 0);
          const oldTop8 = [...myTeam.players]
            .sort((a, b) => (b.bfbValue ?? 0) - (a.bfbValue ?? 0))
            .slice(0, KEEPER_SLOTS)
            .reduce((s, x) => s + (x.bfbValue ?? 0), 0);
          return newTop8 >= oldTop8 * 0.9; // willing to lose up to 10% for a pick
        });

        // 1. Player for Pick (1-for-1)
        const p4pCandidates = myTradeable
          .filter((p) => {
            const val = p.bfbValue ?? 0;
            const inRange = val >= targetValue * 0.65 && val <= targetValue * 1.35;
            // Seller must benefit: player cracks their top 8
            const sellerFloor = sellerTeam.keeperWorthy.length >= KEEPER_SLOTS
              ? sellerTeam.keeperWorthy[KEEPER_SLOTS - 1].bfbValue ?? 0
              : 0;
            return inRange && val > sellerFloor;
          })
          .sort((a, b) => {
            const aFills = sellerTeam.needs.includes(a.position) ? 0 : 1;
            const bFills = sellerTeam.needs.includes(b.position) ? 0 : 1;
            if (aFills !== bFills) return aFills - bFills;
            return Math.abs((a.bfbValue ?? 0) - targetValue) - Math.abs((b.bfbValue ?? 0) - targetValue);
          });

        if (p4pCandidates.length > 0) {
          const candidate = p4pCandidates[0];
          const fairness = computeFairness(
            [candidate.bfbValue ?? 0], 0, 1,
            [], targetValue, 1,
          );
          deals.push({
            target_team: { roster_id: sellerTeam.roster_id, display_name: sellerTeam.display_name },
            type: "player_for_pick",
            give: { players: [formatPlayer(candidate)], picks: [] },
            receive: { players: [], picks: [targetPickFormatted] },
            fairness,
            rationale: `Send ${candidate.position}${sellerTeam.needs.includes(candidate.position) ? " (fills their need)" : ""} to ${sellerTeam.display_name} for their pick`,
          });
        }

        // 2. Player + Picks for Pick
        const myPicks = draftPicks.filter((p) => p.current_roster_id === parseInt(roster_id));
        const playerPlusPick = myTradeable
          .filter((p) => {
            const val = p.bfbValue ?? 0;
            return val >= targetValue * 0.4 && val < targetValue * 0.75;
          })
          .sort((a, b) => (b.bfbValue ?? 0) - (a.bfbValue ?? 0));

        if (playerPlusPick.length > 0 && myPicks.length > 0) {
          const basePlayer = playerPlusPick[0];
          const gap = targetValue - (basePlayer.bfbValue ?? 0);
          const valuedPicks = myPicks
            .map((p) => ({ ...p, pick_value: rawPickValue(p) }))
            .sort((a, b) => b.pick_value - a.pick_value);

          let picksToInclude = [];
          let pickTotal = 0;
          for (const pick of valuedPicks) {
            if (pickTotal >= gap * 1.1) break;
            picksToInclude.push(pick);
            pickTotal += pick.pick_value;
            if (picksToInclude.length >= 2) break;
          }

          const discountedPickTotal = applyConsolidationDiscount(pickTotal, picksToInclude.length);
          if (discountedPickTotal >= gap * 0.6) {
            const fairness = computeFairness(
              [basePlayer.bfbValue ?? 0], pickTotal, 1,
              [], targetValue, 1 + picksToInclude.length,
            );
            deals.push({
              target_team: { roster_id: sellerTeam.roster_id, display_name: sellerTeam.display_name },
              type: "player_plus_picks",
              give: {
                players: [formatPlayer(basePlayer)],
                picks: picksToInclude.map((p) => formatPick(p, rosterToSlot)),
              },
              receive: { players: [], picks: [targetPickFormatted] },
              fairness,
              rationale: `Send ${basePlayer.position} + pick${picksToInclude.length > 1 ? "s" : ""} to ${sellerTeam.display_name} for their pick`,
            });
          }
        }

        // 3. Multi-player for Pick (2-for-1)
        const multiCandidates = myTradeable
          .filter((p) => (p.bfbValue ?? 0) >= targetValue * 0.25)
          .slice(0, 6);

        if (multiCandidates.length >= 2) {
          for (let i = 0; i < multiCandidates.length; i++) {
            for (let j = i + 1; j < multiCandidates.length; j++) {
              const p1 = multiCandidates[i];
              const p2 = multiCandidates[j];
              const comboValue = (p1.bfbValue ?? 0) + (p2.bfbValue ?? 0);
              const sellerBenefits = comboValue >= targetValue * 0.85;

              if (comboValue >= targetValue * 0.85 && comboValue <= targetValue * 1.6 && sellerBenefits) {
                const fairness = computeFairness(
                  [(p1.bfbValue ?? 0), (p2.bfbValue ?? 0)].sort((a, b) => b - a), 0, 1,
                  [], targetValue, 2,
                );
                deals.push({
                  target_team: { roster_id: sellerTeam.roster_id, display_name: sellerTeam.display_name },
                  type: "multi_player",
                  give: { players: [formatPlayer(p1), formatPlayer(p2)], picks: [] },
                  receive: { players: [], picks: [targetPickFormatted] },
                  fairness,
                  rationale: `2-for-1: send ${p1.position} + ${p2.position} to ${sellerTeam.display_name} for their pick`,
                });
                break;
              }
            }
            if (deals.filter((d) => d.type === "multi_player").length > 0) break;
          }
        }

        // 4. Picks-only: trade up by sending multiple of my picks (reuse myPicks from above)
        if (myPicks.length > 0) {
          const valuedMyPicks = myPicks
            .map((p) => ({ ...p, pick_value: rawPickValue(p) }))
            .filter((p) => p.pick_value < targetValue)
            .sort((a, b) => b.pick_value - a.pick_value);

          let swapPicks = [];
          let swapTotal = 0;
          for (const pick of valuedMyPicks) {
            if (swapTotal >= targetValue * 0.9) break;
            swapPicks.push(pick);
            swapTotal += pick.pick_value;
            if (swapPicks.length >= 3) break;
          }

          // Apply consolidation discount — trading up always costs more than raw sum
          const discountedSwap = applyConsolidationDiscount(swapTotal, swapPicks.length);
          if (swapPicks.length >= 2 && discountedSwap >= targetValue * 0.80) {
            const fairness = computeFairness(
              [], swapTotal, 1,
              [], targetValue, swapPicks.length,
            );
            deals.push({
              target_team: { roster_id: sellerTeam.roster_id, display_name: sellerTeam.display_name },
              type: "picks_only",
              give: {
                players: [],
                picks: swapPicks.map((p) => formatPick(p, rosterToSlot)),
              },
              receive: { players: [], picks: [targetPickFormatted] },
              fairness,
              rationale: `Trade up: send ${swapPicks.length} picks to ${sellerTeam.display_name} for their premium pick`,
            });
          }
        }
      }

      // Filter, rank, deduplicate — same logic as player deals
      const filteredDeals = !deal_pref || deal_pref === "any"
        ? deals
        : deals.filter((d) => {
            if (deal_pref === "players_only") return d.type === "pick_for_player" || d.type === "player_for_pick" || d.type === "multi_player";
            if (deal_pref === "player_plus_picks") return d.type === "player_plus_picks" || d.type === "picks_only";
            return true;
          });

      filteredDeals.sort((a, b) => Math.abs(a.fairness - 50) - Math.abs(b.fairness - 50));

      const seen = new Set();
      const topDeals = [];
      for (const deal of filteredDeals) {
        const key = `${deal.type}-${deal.target_team.roster_id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        topDeals.push(deal);
        if (topDeals.length >= 4) break;
      }

      return res.json({
        pick: targetPickFormatted,
        target_type: "pick",
        team_needs: myTeam.needs,
        team_surplus_count: myTeam.surplus.length,
        is_selling: isSelling,
        deals: topDeals,
      });
    }

    // ── PLAYER TARGET (existing logic) ──
    const selectedPlayer = playerMap[player_id];
    if (!selectedPlayer) return res.status(404).json({ message: "Player not found" });

    // Determine if this is a sell (own player) or buy (other team's player)
    const ownerRosterId = rosters.find((r) =>
      (r.player_ids ?? []).includes(player_id),
    )?.roster_id;
    const isSelling = ownerRosterId === parseInt(roster_id);

    const selectedValue = selectedPlayer.bfbValue ?? 0;

    // 6. Generate deals
    const deals = [];

    if (isSelling) {
      // ── SELLING: find teams that want our player ──
      const myPostTradeFloor = getPostTradeFloor(myTeam, selectedPlayer);

      for (const team of teams) {
        if (team.roster_id === parseInt(roster_id)) continue;

        // Would selected player be in this team's top 8?
        const teamTop8Value = team.keeperWorthy.length >= KEEPER_SLOTS
          ? team.keeperWorthy[KEEPER_SLOTS - 1].bfbValue ?? 0
          : 0;
        if (selectedValue <= teamTop8Value && team.keeperWorthy.length >= KEEPER_SLOTS) continue;

        // Players this team would rationally trade for the selected player
        const tradeable = getTradeablePlayers(team, selectedPlayer);

        // 6a. Player-for-player — candidate must also be keeper-worthy on MY team
        const p4pCandidates = tradeable
          .filter((p) => {
            const val = p.bfbValue ?? 0;
            const inRange = val >= selectedValue * 0.65 && val <= selectedValue * 1.35;
            const wouldKeep = val > myPostTradeFloor;
            return inRange && wouldKeep;
          })
          .sort((a, b) => {
            const aFills = myTeam.needs.includes(a.position) ? 0 : 1;
            const bFills = myTeam.needs.includes(b.position) ? 0 : 1;
            if (aFills !== bFills) return aFills - bFills;
            return Math.abs((a.bfbValue ?? 0) - selectedValue) - Math.abs((b.bfbValue ?? 0) - selectedValue);
          });

        if (p4pCandidates.length > 0) {
          const candidate = p4pCandidates[0];
          const fairness = computeFairness(
            [selectedValue], 0, 1,
            [candidate.bfbValue ?? 0], 0, 1,
          );
          deals.push({
            target_team: { roster_id: team.roster_id, display_name: team.display_name },
            type: "player_for_player",
            give: { players: [formatPlayer(selectedPlayer)], picks: [] },
            receive: { players: [formatPlayer(candidate)], picks: [] },
            fairness,
            rationale: `1-for-1: get ${candidate.position}${myTeam.needs.includes(candidate.position) ? " (fills need)" : ""}, ${team.display_name} gets ${selectedPlayer.position} for their top 8`,
          });
        }

        // 6b. Player + picks — base player must be keeper-worthy on my team
        const teamPicks = draftPicks.filter((p) => p.current_roster_id === team.roster_id);
        const playerPlusPick = tradeable
          .filter((p) => {
            const val = p.bfbValue ?? 0;
            const wouldKeep = val > myPostTradeFloor;
            return val >= selectedValue * 0.4 && val < selectedValue * 0.75 && wouldKeep;
          })
          .sort((a, b) => (b.bfbValue ?? 0) - (a.bfbValue ?? 0));

        if (playerPlusPick.length > 0 && teamPicks.length > 0) {
          const basePlayer = playerPlusPick[0];
          const gap = selectedValue - (basePlayer.bfbValue ?? 0);

          const valuedPicks = teamPicks
            .map((p) => ({ ...p, pick_value: rawPickValue(p) }))
            .sort((a, b) => b.pick_value - a.pick_value);

          let picksToInclude = [];
          let pickTotal = 0;
          for (const pick of valuedPicks) {
            if (pickTotal >= gap * 1.1) break;
            picksToInclude.push(pick);
            pickTotal += pick.pick_value;
            if (picksToInclude.length >= 2) break;
          }

          const discountedPickTotal = applyConsolidationDiscount(pickTotal, picksToInclude.length);
          // Verify the team actually has enough picks of the required caliber
          const maxRoundNeeded = picksToInclude.length > 0 ? Math.max(...picksToInclude.map((p) => p.round)) : 99;
          const teamAvailableInRange = teamPicks.filter((p) => p.round <= maxRoundNeeded).length;
          if (discountedPickTotal >= gap * 0.6 && teamAvailableInRange >= picksToInclude.length) {
            const fairness = computeFairness(
              [selectedValue], 0, 1 + picksToInclude.length,
              [basePlayer.bfbValue ?? 0], pickTotal, 1,
            );
            deals.push({
              target_team: { roster_id: team.roster_id, display_name: team.display_name },
              type: "player_plus_picks",
              give: { players: [formatPlayer(selectedPlayer)], picks: [] },
              receive: {
                players: [formatPlayer(basePlayer)],
                picks: picksToInclude.map((p) => formatPick(p, rosterToSlot)),
              },
              fairness,
              rationale: `${basePlayer.position} + pick${picksToInclude.length > 1 ? "s" : ""} from ${team.display_name} for your ${selectedPlayer.position}`,
            });
          }
        }

        // 6c. Multi-player — at least one received player must be keeper-worthy on my team
        const multiCandidates = tradeable
          .filter((p) => (p.bfbValue ?? 0) >= selectedValue * 0.25)
          .slice(0, 6);

        if (multiCandidates.length >= 2) {
          for (let i = 0; i < multiCandidates.length; i++) {
            for (let j = i + 1; j < multiCandidates.length; j++) {
              const p1 = multiCandidates[i];
              const p2 = multiCandidates[j];
              const comboValue = (p1.bfbValue ?? 0) + (p2.bfbValue ?? 0);
              const eitherKeepable = (p1.bfbValue ?? 0) > myPostTradeFloor || (p2.bfbValue ?? 0) > myPostTradeFloor;
              // Verify the other team would still do this 2-for-1
              const theyImprove = tradeImprovesTeam(team, [p1, p2], selectedPlayer);

              if (comboValue >= selectedValue * 0.85 && comboValue <= selectedValue * 1.6 && eitherKeepable && theyImprove) {
                const fairness = computeFairness(
                  [selectedValue], 0, 2,
                  [(p1.bfbValue ?? 0), (p2.bfbValue ?? 0)].sort((a, b) => b - a), 0, 1,
                );
                deals.push({
                  target_team: { roster_id: team.roster_id, display_name: team.display_name },
                  type: "multi_player",
                  give: { players: [formatPlayer(selectedPlayer)], picks: [] },
                  receive: { players: [formatPlayer(p1), formatPlayer(p2)], picks: [] },
                  fairness,
                  rationale: `2-for-1: ${p1.position} + ${p2.position} package from ${team.display_name}`,
                });
                break;
              }
            }
            if (deals.filter((d) => d.target_team.roster_id === team.roster_id && d.type === "multi_player").length > 0) break;
          }
        }
      }
    } else {
      // ── BUYING: find what we can offer to acquire this player ──
      const sellerTeam = teams.find((t) => t.roster_id === ownerRosterId);
      if (!sellerTeam) return res.json({ player: formatPlayer(selectedPlayer), team_needs: myTeam.needs, deals: [] });

      // Validate: would this player actually crack my top 8?
      const myCurrentFloor = myTeam.keeperWorthy.length >= KEEPER_SLOTS
        ? myTeam.keeperWorthy[KEEPER_SLOTS - 1].bfbValue ?? 0
        : 0;
      if (selectedValue <= myCurrentFloor && myTeam.keeperWorthy.length >= KEEPER_SLOTS) {
        return res.json({ player: formatPlayer(selectedPlayer), team_needs: myTeam.needs, deals: [], message: "This player wouldn't improve your keeper roster" });
      }

      // Players I could rationally offer (trading them + receiving selected player improves my team)
      const myTradeable = getTradeablePlayers(myTeam, selectedPlayer);

      // 6a. Player-for-player: offer one of our tradeable players
      const p4pCandidates = myTradeable
        .filter((p) => {
          const val = p.bfbValue ?? 0;
          const inRange = val >= selectedValue * 0.65 && val <= selectedValue * 1.35;
          // Seller must also benefit: their team improves receiving our player
          const sellerBenefits = tradeImprovesTeam(sellerTeam, selectedPlayer, p);
          return inRange && sellerBenefits;
        })
        .sort((a, b) => {
          const aFills = sellerTeam.needs.includes(a.position) ? 0 : 1;
          const bFills = sellerTeam.needs.includes(b.position) ? 0 : 1;
          if (aFills !== bFills) return aFills - bFills;
          return Math.abs((a.bfbValue ?? 0) - selectedValue) - Math.abs((b.bfbValue ?? 0) - selectedValue);
        });

      if (p4pCandidates.length > 0) {
        const candidate = p4pCandidates[0];
        const fairness = computeFairness(
          [candidate.bfbValue ?? 0], 0, 1,
          [selectedValue], 0, 1,
        );
        deals.push({
          target_team: { roster_id: sellerTeam.roster_id, display_name: sellerTeam.display_name },
          type: "player_for_player",
          give: { players: [formatPlayer(candidate)], picks: [] },
          receive: { players: [formatPlayer(selectedPlayer)], picks: [] },
          fairness,
          rationale: `1-for-1: send ${candidate.position}${sellerTeam.needs.includes(candidate.position) ? " (fills their need)" : ""}, get ${selectedPlayer.position}`,
        });
      }

      // 6b. Our player + our picks to acquire
      const myPicks = draftPicks.filter((p) => p.current_roster_id === parseInt(roster_id));
      const playerPlusPick = myTradeable
        .filter((p) => {
          const val = p.bfbValue ?? 0;
          return val >= selectedValue * 0.4 && val < selectedValue * 0.75;
        })
        .sort((a, b) => (b.bfbValue ?? 0) - (a.bfbValue ?? 0));

      if (playerPlusPick.length > 0 && myPicks.length > 0) {
        const basePlayer = playerPlusPick[0];
        const gap = selectedValue - (basePlayer.bfbValue ?? 0);

        const valuedPicks = myPicks
          .map((p) => ({ ...p, pick_value: rawPickValue(p) }))
          .sort((a, b) => b.pick_value - a.pick_value);

        let picksToInclude = [];
        let pickTotal = 0;
        for (const pick of valuedPicks) {
          if (pickTotal >= gap * 1.1) break;
          picksToInclude.push(pick);
          pickTotal += pick.pick_value;
          if (picksToInclude.length >= 2) break;
        }

        const discountedPickTotal = applyConsolidationDiscount(pickTotal, picksToInclude.length);
        if (discountedPickTotal >= gap * 0.6) {
          const fairness = computeFairness(
            [basePlayer.bfbValue ?? 0], pickTotal, 1,
            [selectedValue], 0, 1 + picksToInclude.length,
          );
          deals.push({
            target_team: { roster_id: sellerTeam.roster_id, display_name: sellerTeam.display_name },
            type: "player_plus_picks",
            give: {
              players: [formatPlayer(basePlayer)],
              picks: picksToInclude.map((p) => formatPick(p, rosterToSlot)),
            },
            receive: { players: [formatPlayer(selectedPlayer)], picks: [] },
            fairness,
            rationale: `Send ${basePlayer.position} + pick${picksToInclude.length > 1 ? "s" : ""} to ${sellerTeam.display_name} for their ${selectedPlayer.position}`,
          });
        }
      }

      // 6c. Multi-player: offer 2 of our tradeable players
      const multiCandidates = myTradeable
        .filter((p) => (p.bfbValue ?? 0) >= selectedValue * 0.25)
        .slice(0, 6);

      if (multiCandidates.length >= 2) {
        for (let i = 0; i < multiCandidates.length; i++) {
          for (let j = i + 1; j < multiCandidates.length; j++) {
            const p1 = multiCandidates[i];
            const p2 = multiCandidates[j];
            const comboValue = (p1.bfbValue ?? 0) + (p2.bfbValue ?? 0);
            // Seller must benefit from receiving both our players for their one
            const sellerBenefits = tradeImprovesTeam(sellerTeam, selectedPlayer, [p1, p2]);

            if (comboValue >= selectedValue * 0.85 && comboValue <= selectedValue * 1.6 && sellerBenefits) {
              const fairness = computeFairness(
                [(p1.bfbValue ?? 0), (p2.bfbValue ?? 0)].sort((a, b) => b - a), 0, 1,
                [selectedValue], 0, 2,
              );
              deals.push({
                target_team: { roster_id: sellerTeam.roster_id, display_name: sellerTeam.display_name },
                type: "multi_player",
                give: { players: [formatPlayer(p1), formatPlayer(p2)], picks: [] },
                receive: { players: [formatPlayer(selectedPlayer)], picks: [] },
                fairness,
                rationale: `2-for-1: send ${p1.position} + ${p2.position} to ${sellerTeam.display_name}`,
              });
              break;
            }
          }
          if (deals.filter((d) => d.type === "multi_player").length > 0) break;
        }
      }
    }

    // 6b. Bilateral surplus swaps — "I have surplus RB, you have surplus WR, we both fill a hole"
    // Always anchored to the searched player: must give or receive selectedPlayer.
    if (myTeam) {
      const COMPLEMENT_MAP = { RB: ["WR", "TE"], WR: ["RB", "TE"], TE: ["RB", "WR"], QB: ["WR"] };

      if (isSelling) {
        const isSelectedSurplus = myTeam.surplus.some((p) => p.id === player_id);
        if (isSelectedSurplus) {
          const myPos = selectedPlayer.position;
          const myVal = selectedValue;
          const compPositions = COMPLEMENT_MAP[myPos] ?? [];

          for (const team of teams) {
            if (team.roster_id === parseInt(roster_id)) continue;
            if (!team.needs.includes(myPos)) continue;

            const theirMatch = team.surplus.find(
              (p) =>
                compPositions.includes(p.position) &&
                (p.bfbValue ?? 0) >= myVal * 0.7 &&
                (p.bfbValue ?? 0) <= myVal * 1.3,
            );
            if (!theirMatch) continue;

            const fairness = computeFairness([myVal], 0, 1, [theirMatch.bfbValue ?? 0], 0, 1);
            deals.push({
              target_team: { roster_id: team.roster_id, display_name: team.display_name },
              type: "bilateral_surplus_swap",
              give: { players: [formatPlayer(selectedPlayer)], picks: [] },
              receive: { players: [formatPlayer(theirMatch)], picks: [] },
              fairness,
              rationale: `Surplus swap: send ${myPos}, receive ${theirMatch.position}${myTeam.needs.includes(theirMatch.position) ? " (fills your need)" : ""}`,
            });
            break;
          }
        }
      } else {
        const targetTeam = teams.find((t) => t.roster_id === ownerRosterId);
        if (targetTeam && targetTeam.surplus.some((p) => p.id === player_id)) {
          const theirPos = selectedPlayer.position;
          const theirVal = selectedValue;
          const myComplementPositions = Object.entries(COMPLEMENT_MAP)
            .filter(([, comps]) => comps.includes(theirPos))
            .map(([pos]) => pos);

          const myMatch = myTeam.surplus.find(
            (p) =>
              myComplementPositions.includes(p.position) &&
              targetTeam.needs.includes(p.position) &&
              (p.bfbValue ?? 0) >= theirVal * 0.7 &&
              (p.bfbValue ?? 0) <= theirVal * 1.3,
          );
          if (myMatch) {
            const fairness = computeFairness([myMatch.bfbValue ?? 0], 0, 1, [theirVal], 0, 1);
            deals.push({
              target_team: { roster_id: targetTeam.roster_id, display_name: targetTeam.display_name },
              type: "bilateral_surplus_swap",
              give: { players: [formatPlayer(myMatch)], picks: [] },
              receive: { players: [formatPlayer(selectedPlayer)], picks: [] },
              fairness,
              rationale: `Surplus swap: send ${myMatch.position}, receive ${theirPos}${myTeam.needs.includes(theirPos) ? " (fills your need)" : ""}`,
            });
          }
        }
      }
    }

    // 7. Filter by deal preference
    const filteredDeals = !deal_pref || deal_pref === "any"
      ? deals
      : deals.filter((d) => {
          if (deal_pref === "players_only") return d.type === "player_for_player" || d.type === "multi_player";
          if (deal_pref === "player_plus_picks") return d.type === "player_plus_picks";
          return true;
        });

    // 8. Score and rank — prefer fairest deals, limit to 4

    // Age/timeline re-scoring: penalize acquiring older players, bonus for acquiring younger
    for (const deal of filteredDeals) {
      if (!["player_for_player", "player_plus_picks"].includes(deal.type)) continue;
      const givenAge = deal.give?.players?.[0]?.age ?? 27;
      const recvAge = deal.receive?.players?.[0]?.age ?? 27;
      const diff = recvAge - givenAge;
      if (diff >= 3) deal.fairness = Math.round(deal.fairness * 0.92);
      else if (diff <= -2) deal.fairness = Math.min(Math.round(deal.fairness * 1.05), 65);
    }

    filteredDeals.sort((a, b) => Math.abs(a.fairness - 50) - Math.abs(b.fairness - 50));

    // Deduplicate: max 1 deal per type per team, max 4 total
    const seen = new Set();
    const topDeals = [];
    for (const deal of filteredDeals) {
      const key = `${deal.type}-${deal.target_team.roster_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      topDeals.push(deal);
      if (topDeals.length >= 4) break;
    }

    res.json({
      player: formatPlayer(selectedPlayer),
      team_needs: myTeam.needs,
      team_surplus_count: myTeam.surplus.length,
      is_selling: isSelling,
      deals: topDeals,
    });
  } catch (error) {
    console.error("Error finding deals:", error);
    res.status(500).send({ error: error.message, message: "Internal Server Error" });
  }
};

function formatPlayer(p) {
  return {
    id: p.id,
    full_name: p.full_name || p.player_name || "Unknown",
    position: p.position,
    team: p.team,
    bfbValue: p.bfbValue ?? 0,
    age: p.age ?? null,
  };
}

function formatPick(pick, rosterToSlot) {
  const slot = rosterToSlot[pick.original_roster_id] ?? 6;
  return {
    round: pick.round,
    season: pick.season,
    original_roster_id: pick.original_roster_id,
    current_roster_id: pick.current_roster_id,
    estimated_slot: slot,
    pick_value: getPickValue(pick.round, slot, pick.season > new Date().getFullYear() ? 1 : 0),
  };
}

/**
 * Select picks to bridge a value gap, preferring "1 anchor pick + change back" over "2 mediocre picks".
 *
 * @param {Object[]} availablePicks - picks available to send (sorted desc by pick_value)
 * @param {number} gap - value gap to bridge
 * @param {Object[]} otherSideLatePicks - late-round picks from the other side (for "change back")
 * @param {Set} [usedPickKeys] - picks already committed in other deals
 * @returns {{ givePicks, receivePicks }} - picks to send and receive (change back)
 */
function selectPickPackage(availablePicks, gap, otherSideLatePicks = [], usedPickKeys = new Set()) {
  const available = availablePicks.filter(
    (p) => !usedPickKeys.has(`${p.round}-${p.season}-${p.original_roster_id}`),
  );

  // Strategy 1: Single anchor pick (widened to 70%-140% of gap)
  const anchor = available.find((p) => p.pick_value >= gap * 0.7 && p.pick_value <= gap * 1.4);
  if (anchor) {
    return { givePicks: [anchor], receivePicks: [] };
  }

  // Strategy 2: Single pick that overshoots — get a late-round pick back as change
  const overshooter = available.find((p) => p.pick_value > gap * 1.4 && p.pick_value <= gap * 2.5);
  if (overshooter && otherSideLatePicks.length > 0) {
    const overshoot = overshooter.pick_value - gap;
    const changePick = otherSideLatePicks.find(
      (p) => p.pick_value >= overshoot * 0.4 && p.pick_value <= overshoot * 1.5,
    );
    if (changePick) {
      return { givePicks: [overshooter], receivePicks: [changePick] };
    }
  }

  // Strategy 3: Fallback — greedy fill with consolidation penalty (up to 3 picks, 50% threshold)
  let picksToInclude = [];
  let pickTotal = 0;
  for (const pick of available) {
    if (pickTotal >= gap * 1.1) break;
    picksToInclude.push(pick);
    pickTotal += pick.pick_value;
    if (picksToInclude.length >= 3) break;
  }

  const discounted = applyConsolidationDiscount(pickTotal, picksToInclude.length);
  if (picksToInclude.length > 0 && discounted >= gap * 0.5) {
    return { givePicks: picksToInclude, receivePicks: [] };
  }

  return { givePicks: [], receivePicks: [] };
}

function computeFairness(aValues, aPickVal, bAssetCount, bValues, bPickVal, aAssetCount) {
  const globalMax = Math.max(...aValues, aPickVal, ...bValues, bPickVal, 1);
  const aSide = calculateTradeValue(aValues, aPickVal, bAssetCount, globalMax);
  const bSide = calculateTradeValue(bValues, bPickVal, aAssetCount, globalMax);
  const total = aSide.total + bSide.total || 1;
  return Math.round((aSide.total / total) * 100);
}

// Raw fairness: straight sum comparison without elite curve or package tax.
// Used for recommended trade filtering where the curved metric is misleading
// (multi-asset sides always look cheaper due to non-linear scaling + tax).
function computeRawFairness(aValues, aPickVal, bValues, bPickVal) {
  const aTotal = aValues.reduce((s, v) => s + v, 0) + aPickVal;
  const bTotal = bValues.reduce((s, v) => s + v, 0) + bPickVal;
  const total = aTotal + bTotal || 1;
  return Math.round((aTotal / total) * 100);
}

export const getTradeTargets = async (req, res) => {
  try {
    const { leagueId, rosterId } = req.params;
    const { year = new Date().getFullYear() } = req.query;

    const rosters = await getRostersWithOwners(leagueId);
    const myRoster = rosters.find((r) => r.roster_id === parseInt(rosterId));
    if (!myRoster) return res.status(404).json({ message: "Roster not found" });

    const allPlayerIds = [
      ...new Set(rosters.flatMap((r) => r.player_ids ?? [])),
    ];
    const players = await getSkillPlayersByIds(allPlayerIds, year);

    const { withValues } = enrichPlayers(players);

    const myPlayerIds = new Set(myRoster.player_ids ?? []);
    const myPlayers = withValues.filter((p) => myPlayerIds.has(p.id));

    const myByPos = {};
    for (const pos of Object.keys(STARTER_COUNTS)) {
      myByPos[pos] = myPlayers
        .filter((p) => p.position === pos)
        .sort((a, b) => (b.bfbValue ?? 0) - (a.bfbValue ?? 0));
    }

    const needScores = {};
    for (const [pos, starters] of Object.entries(STARTER_COUNTS)) {
      const myStarters = myByPos[pos].slice(0, starters);
      const avgValue = myStarters.length
        ? myStarters.reduce((s, p) => s + (p.bfbValue ?? 0), 0) / myStarters.length
        : 0;
      needScores[pos] = Math.max(0, 1000 - avgValue);
    }

    const rosterOwnerMap = {};
    for (const r of rosters) {
      for (const id of r.player_ids ?? []) rosterOwnerMap[id] = r.roster_id;
    }

    const targets = withValues
      .filter(
        (p) => !myPlayerIds.has(p.id) && rosterOwnerMap[p.id] !== undefined,
      )
      .map((p) => ({
        ...p,
        current_roster_id: rosterOwnerMap[p.id],
        need_score: needScores[p.position] ?? 0,
        target_score: Math.round(
          (p.bfbValue ?? 0) * 0.6 + (needScores[p.position] ?? 0) * 0.4,
        ),
      }))
      .sort((a, b) => b.target_score - a.target_score)
      .slice(0, 10);

    res.json({ needs: needScores, targets });
  } catch (error) {
    console.error("Error fetching trade targets:", error);
    res.status(500).send({ error, message: "Internal Server Error" });
  }
};

// ── Recommended Trades ───────────────────────────────────────────────────

export const getRecommendedTrades = async (req, res) => {
  try {
    const { roster_id, league_id } = req.body;
    const year = parseInt(req.query.year) || new Date().getFullYear();

    if (!roster_id || !league_id) {
      return res.status(400).json({ message: "roster_id and league_id are required" });
    }

    // 1. Fetch rosters with owner names
    const rosters = await getRostersWithOwners(league_id);

    const myRoster = rosters.find((r) => r.roster_id === parseInt(roster_id));
    if (!myRoster) return res.status(404).json({ message: "Roster not found" });

    // 2. Fetch + enrich all rostered players
    const allPlayerIds = [...new Set(rosters.flatMap((r) => r.player_ids ?? []))];
    const players = await getSkillPlayersByIds(allPlayerIds, year);

    const { withValues, playerMap } = enrichPlayers(players);

    // 2b. Fetch Sleeper rosters to check for set keepers
    const sleeperKeepers = await fetchSleeperKeepers(league_id);

    // 3. Keeper-worthy pool + team analysis
    const keeperWorthyIds = getKeeperWorthyIds(withValues);
    const teams = buildTeamAnalysis(rosters, playerMap, keeperWorthyIds, sleeperKeepers);

    const myTeam = teams.find((t) => t.roster_id === parseInt(roster_id));

    // 4. Pick slot map + draft picks
    const [{ rosterToSlot }, draftPicks] = await Promise.all([
      getPickSlotMap(league_id),
      getDraftPicksByLeague(league_id),
    ]);

    // Pick value using the perceived-value curve
    const rawPickValue = (pick) =>
      getPickValue(pick.round, rosterToSlot[pick.original_roster_id] ?? 6, pick.season > year ? 1 : 0);

    // ── Category 1: Upgrades ──
    // For each position in my top 8, find better players on other teams
    const upgrades = [];
    const myTop8 = myTeam.keeperWorthy.slice(0, KEEPER_SLOTS);

    const myPicks = draftPicks.filter((p) => p.current_roster_id === parseInt(roster_id));
    // Only include rounds 1-3 for upgrades — rounds 4+ are junk filler, not trade pieces
    const myTradePicks = myPicks
      .filter((p) => p.round <= 3)
      .map((p) => ({ ...p, pick_value: rawPickValue(p) }))
      .sort((a, b) => b.pick_value - a.pick_value);

    // Build a set of pick keys already used across upgrade deals
    const usedUpgradePickKeys = new Set();

    for (const myPlayer of myTop8) {
      const pos = myPlayer.position;
      const myVal = myPlayer.bfbValue ?? 0;

      for (const team of teams) {
        if (team.roster_id === parseInt(roster_id)) continue;

        // Find their players at same position that are better than mine
        const betterPlayers = team.players
          .filter((p) => p.position === pos && keeperWorthyIds.has(p.id) && (p.bfbValue ?? 0) > myVal * 1.15)
          .sort((a, b) => (b.bfbValue ?? 0) - (a.bfbValue ?? 0));

        for (const target of betterPlayers) {
          const targetVal = target.bfbValue ?? 0;

          // Hard skip: never recommend acquiring a player 6+ years older.
          // Use real age from keeper_values.csv when available; fall back to years_exp.
          const myAge = myPlayer.age ?? (myPlayer.years_exp != null ? 22 + myPlayer.years_exp : 27);
          const targetAge = target.age ?? (target.years_exp != null ? 22 + target.years_exp : 27);
          const ageDiff = targetAge - myAge;  // positive = target is older
          if (ageDiff >= 6) break;

          // Tiered age penalty: acquiring an older player reduces their effective value;
          // acquiring a younger one increases it.
          let ageFactor = 1.0;
          if (ageDiff >= 5)       ageFactor = 0.75;
          else if (ageDiff >= 3)  ageFactor = 0.85;
          else if (ageDiff <= -2) ageFactor = 1.10;
          const adjustedTargetVal = Math.round(targetVal * ageFactor);

          const gap = adjustedTargetVal - myVal;

          // Other team's late picks available as "change back"
          const theirLatePicks = draftPicks
            .filter((p) => p.current_roster_id === team.roster_id && p.round >= 3)
            .map((p) => ({ ...p, pick_value: rawPickValue(p) }))
            .sort((a, b) => a.pick_value - b.pick_value);

          const { givePicks, receivePicks } = selectPickPackage(
            myTradePicks, gap, theirLatePicks, usedUpgradePickKeys,
          );

          if (givePicks.length > 0) {
            const givePickTotal = givePicks.reduce((s, p) => s + p.pick_value, 0);
            const receivePickTotal = receivePicks.reduce((s, p) => s + p.pick_value, 0);
            const rawFairness = computeRawFairness(
              [myVal], givePickTotal, [adjustedTargetVal], receivePickTotal,
            );
            for (const p of givePicks) usedUpgradePickKeys.add(`${p.round}-${p.season}-${p.original_roster_id}`);
            upgrades.push({
              target_team: { roster_id: team.roster_id, display_name: team.display_name },
              type: "player_plus_picks",
              give: {
                players: [formatPlayer(myPlayer)],
                picks: givePicks.map((p) => formatPick(p, rosterToSlot)),
              },
              receive: {
                players: [formatPlayer(target)],
                picks: receivePicks.map((p) => formatPick(p, rosterToSlot)),
              },
              fairness: rawFairness,
              rationale: `Upgrade ${pos}: ${myPlayer.full_name} + picks → ${target.full_name}${receivePicks.length > 0 ? " + Rd" + receivePicks[0].round : ""}`,
              category: "upgrade",
            });
          }
          break; // one deal per target team per position
        }
      }
    }

    // ── Category 2: Fill Needs ──
    // For each positional need, find keeper-worthy players on other teams
    const fillNeed = [];

    for (const pos of myTeam.needs) {
      for (const team of teams) {
        if (team.roster_id === parseInt(roster_id)) continue;

        // Their keeper-worthy players at this position
        const candidates = team.players
          .filter((p) => p.position === pos && keeperWorthyIds.has(p.id))
          .sort((a, b) => (b.bfbValue ?? 0) - (a.bfbValue ?? 0));

        for (const target of candidates) {
          const targetVal = target.bfbValue ?? 0;

          // Try surplus player + picks — user overpays to fill the need
          const myOffer = myTeam.surplus
            .filter((p) => (p.bfbValue ?? 0) <= targetVal)
            .sort((a, b) => {
              // Prefer players that fill their needs, then highest value
              const aFills = team.needs.includes(a.position) ? 0 : 1;
              const bFills = team.needs.includes(b.position) ? 0 : 1;
              if (aFills !== bFills) return aFills - bFills;
              return (b.bfbValue ?? 0) - (a.bfbValue ?? 0);
            });

          const offer = myOffer[0];
          if (offer) {
            const offerVal = offer.bfbValue ?? 0;

            // Only suggest if the offered player would crack the receiving team's top 8
            const receivingFloor = team.keeperWorthy.length >= KEEPER_SLOTS
              ? (team.keeperWorthy[KEEPER_SLOTS - 1].bfbValue ?? 0)
              : 0;
            if (team.keeperWorthy.length >= KEEPER_SLOTS && offerVal <= receivingFloor) continue;

            const gap = targetVal - offerVal;

            // If close in value, try 1-for-1
            if (gap <= targetVal * 0.25) {
              const fairness = computeRawFairness(
                [offerVal], 0, [targetVal], 0,
              );
              fillNeed.push({
                target_team: { roster_id: team.roster_id, display_name: team.display_name },
                type: "player_for_player",
                give: { players: [formatPlayer(offer)], picks: [] },
                receive: { players: [formatPlayer(target)], picks: [] },
                fairness,
                rationale: `Fill ${pos} need: send ${offer.position} ${offer.full_name} (surplus), get ${target.full_name}`,
                category: "fill_need",
              });
              break;
            }

            // Otherwise surplus player + picks to bridge the gap
            const usedFillPickKeys = new Set(
              fillNeed.flatMap((d) => (d.give.picks ?? []).map((gp) => `${gp.round}-${gp.season}-${gp.original_roster_id}`)),
            );
            const theirLatePicks = draftPicks
              .filter((p) => p.current_roster_id === team.roster_id && p.round >= 3)
              .map((p) => ({ ...p, pick_value: rawPickValue(p) }))
              .sort((a, b) => a.pick_value - b.pick_value);

            const { givePicks, receivePicks } = selectPickPackage(
              myTradePicks, gap, theirLatePicks, usedFillPickKeys,
            );

            if (givePicks.length > 0) {
              const givePickTotal = givePicks.reduce((s, p) => s + p.pick_value, 0);
              const receivePickTotal = receivePicks.reduce((s, p) => s + p.pick_value, 0);
              const fairness = computeRawFairness(
                [offerVal], givePickTotal, [targetVal], receivePickTotal,
              );
              fillNeed.push({
                target_team: { roster_id: team.roster_id, display_name: team.display_name },
                type: "player_plus_picks",
                give: {
                  players: [formatPlayer(offer)],
                  picks: givePicks.map((p) => formatPick(p, rosterToSlot)),
                },
                receive: {
                  players: [formatPlayer(target)],
                  picks: receivePicks.map((p) => formatPick(p, rosterToSlot)),
                },
                fairness,
                rationale: `Fill ${pos} need: ${offer.full_name} + picks → ${target.full_name}${receivePicks.length > 0 ? " + Rd" + receivePicks[0].round : ""}`,
                category: "fill_need",
              });
              break;
            }
          }

          // Fallback: lower keeper + picks
          const myLowerKeepers = myTop8
            .filter((p) => {
              const val = p.bfbValue ?? 0;
              return val >= targetVal * 0.3 && val < targetVal * 0.8;
            })
            .sort((a, b) => (b.bfbValue ?? 0) - (a.bfbValue ?? 0));

          if (myLowerKeepers.length > 0) {
            const basePlayer = myLowerKeepers[0];
            const fallbackGap = targetVal - (basePlayer.bfbValue ?? 0);

            const usedFallbackKeys = new Set(
              fillNeed.flatMap((d) => (d.give.picks ?? []).map((gp) => `${gp.round}-${gp.season}-${gp.original_roster_id}`)),
            );
            const theirLatePicksFb = draftPicks
              .filter((p) => p.current_roster_id === team.roster_id && p.round >= 3)
              .map((p) => ({ ...p, pick_value: rawPickValue(p) }))
              .sort((a, b) => a.pick_value - b.pick_value);

            const { givePicks: fbGive, receivePicks: fbReceive } = selectPickPackage(
              myTradePicks, fallbackGap, theirLatePicksFb, usedFallbackKeys,
            );

            if (fbGive.length > 0) {
              const givePickTotal = fbGive.reduce((s, p) => s + p.pick_value, 0);
              const receivePickTotal = fbReceive.reduce((s, p) => s + p.pick_value, 0);
              const fairness = computeRawFairness(
                [basePlayer.bfbValue ?? 0], givePickTotal, [targetVal], receivePickTotal,
              );
              fillNeed.push({
                target_team: { roster_id: team.roster_id, display_name: team.display_name },
                type: "player_plus_picks",
                give: {
                  players: [formatPlayer(basePlayer)],
                  picks: fbGive.map((p) => formatPick(p, rosterToSlot)),
                },
                receive: {
                  players: [formatPlayer(target)],
                  picks: fbReceive.map((p) => formatPick(p, rosterToSlot)),
                },
                fairness,
                rationale: `Fill ${pos} need: ${basePlayer.full_name} + picks → ${target.full_name}${fbReceive.length > 0 ? " + Rd" + fbReceive[0].round : ""}`,
                category: "fill_need",
              });
              break;
            }
          }
        }
      }
    }

    // ── Category 3: Sell Surplus ──
    // Trade extra keeper-worthy players for picks or lesser player + picks
    const sellSurplus = [];

    for (const surplusPlayer of myTeam.surplus) {
      const surplusVal = surplusPlayer.bfbValue ?? 0;

      for (const team of teams) {
        if (team.roster_id === parseInt(roster_id)) continue;

        // QB/TE only offered if the team needs that position; WR/RB always offered
        const isScarcityPos = surplusPlayer.position === "QB" || surplusPlayer.position === "TE";
        const teamNeedsPos = team.needs.includes(surplusPlayer.position);
        if (isScarcityPos && !teamNeedsPos) continue;

        // Player must crack the receiving team's top 8
        const teamFloor = team.keeperWorthy.length >= KEEPER_SLOTS
          ? team.keeperWorthy[KEEPER_SLOTS - 1].bfbValue ?? 0
          : 0;
        if (surplusVal <= teamFloor && team.keeperWorthy.length >= KEEPER_SLOTS) continue;

        // effectiveVal = net gain for the buyer: player value minus who they'd drop.
        const effectiveVal = Math.max(surplusVal - teamFloor, 0);
        if (effectiveVal <= 0) continue;

        const teamPicks = draftPicks.filter((p) => p.current_roster_id === team.roster_id);
        if (teamPicks.length === 0) continue;

        // Surplus deals are paid in R3-R5 picks only — 2nd rounders are too valuable to
        // spend on a borderline surplus player. Teams without R3-R5 picks are skipped.
        const teamAnchorPicks = teamPicks
          .filter((p) => p.round >= 3 && p.round <= 5)
          .map((p) => ({ ...p, pick_value: rawPickValue(p) }))
          .sort((a, b) => a.pick_value - b.pick_value);

        if (teamAnchorPicks.length === 0) continue;

        // Apply a seller's discount: surplus players trade at a haircut because the
        // seller is motivated and the buyer takes on marginal roster risk.
        // Targets R3/R4 picks rather than R2s for typical surplus deals.
        const pickTargetVal = Math.round(effectiveVal * 0.75);

        // Find the highest-valued pick that doesn't exceed the discounted target.
        const belowPicks = teamAnchorPicks.filter((p) => p.pick_value <= pickTargetVal);
        const anchor = belowPicks.length > 0
          ? belowPicks[belowPicks.length - 1]
          : teamAnchorPicks[0];

        let receivePicks = [anchor];
        let receiveTotal = anchor.pick_value;
        let givePicks = [];
        let givePickTotal = 0;

        if (receiveTotal > pickTargetVal * 1.3) {
          const myLatePicks = myPicks
            .filter((p) => p.round >= 4)
            .map((p) => ({ ...p, pick_value: rawPickValue(p) }))
            .sort((a, b) => a.pick_value - b.pick_value);

          const overshoot = receiveTotal - pickTargetVal;
          const balancePick = myLatePicks.find((p) => p.pick_value >= overshoot * 0.5 && p.pick_value <= overshoot * 1.5);
          if (balancePick) {
            givePicks.push(balancePick);
            givePickTotal = balancePick.pick_value;
          }
        }

        if (receiveTotal > 0) {
          // Fairness based on effectiveVal, not raw surplusVal
          const fairness = computeRawFairness(
            [effectiveVal], givePickTotal, [], receiveTotal,
          );

          sellSurplus.push({
            target_team: { roster_id: team.roster_id, display_name: team.display_name },
            type: "player_plus_picks",
            give: {
              players: [formatPlayer(surplusPlayer)],
              picks: givePicks.map((p) => formatPick(p, rosterToSlot)),
            },
            receive: {
              players: [],
              picks: receivePicks.map((p) => formatPick(p, rosterToSlot)),
            },
            fairness,
            rationale: `Sell surplus: ${surplusPlayer.full_name} (${surplusPlayer.position}) → ${receivePicks.length} pick${receivePicks.length > 1 ? "s" : ""}${givePicks.length > 0 ? " + send back Rd" + givePicks[0].round : ""} from ${team.display_name}${teamNeedsPos ? " (they need " + surplusPlayer.position + ")" : ""}`,
            category: "sell_surplus",
            _needsPos: teamNeedsPos,
          });
        }
      }
    }

    // Only recommend trades the other team would accept:
    // fairness = raw % of value I'm sending. >=50 means I send at least even value.
    // Cap at 65 to avoid recommending trades that are bad for the user.
    const filterAndSort = (deals) =>
      deals
        .filter((d) => d.fairness >= 50 && d.fairness <= 65)
        .sort((a, b) => a.fairness - b.fairness);

    // Deduplicate: max 1 deal per target team per category
    const dedup = (deals) => {
      const seen = new Set();
      return deals.filter((d) => {
        const key = `${d.target_team.roster_id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    };

    // Surplus deals: no fairness range filter — the anchor pick check (>= effectiveVal * 0.5)
    // already ensures the deal is in the right ballpark. Sort by proximity to 50 so the
    // most even deals surface first (matching trade report behavior).
    const filteredSurplus = [...sellSurplus];
    filteredSurplus.sort((a, b) => {
      if (a._needsPos !== b._needsPos) return a._needsPos ? -1 : 1;
      return Math.abs(a.fairness - 50) - Math.abs(b.fairness - 50);
    });
    filteredSurplus.forEach((d) => delete d._needsPos);

    const top8Value = myTop8.reduce((s, p) => s + (p.bfbValue ?? 0), 0);

    res.json({
      team_analysis: {
        keeper_count: myTeam.keeperWorthy.length,
        top_8_value: Math.round(top8Value),
        needs: myTeam.needs,
        surplus: myTeam.surplus.map(formatPlayer),
      },
      categories: {
        upgrade: dedup(filterAndSort(upgrades)).slice(0, 4),
        fill_need: dedup(filterAndSort(fillNeed)).slice(0, 4),
        sell_surplus: dedup(filteredSurplus).slice(0, 4),
      },
    });
  } catch (error) {
    console.error("Error getting recommended trades:", error);
    res.status(500).send({ error: error.message, message: "Internal Server Error" });
  }
};
