import { exec } from "../db.js";
import {
  computePlayerValues,
  getPickValue,
  calculateTradeValue,
  applyEliteCurve,
  getPackageTax,
} from "../utils/calculations.js";
import { getPickSlotMap } from "../utils/pickSlots.js";
import { enrichWithKeeperValues } from "../utils/keeperValues.js";
import { runTradeBridge } from "../utils/pythonBridge.js";

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
    const { year = new Date().getFullYear() } = req.query;

    const allPlayerIds = [...(side_a.players ?? []), ...(side_b.players ?? [])];
    const players = allPlayerIds.length
      ? await exec(
          `SELECT * FROM vw_players WHERE id = ANY($1::text[]) AND year = $2`,
          [allPlayerIds, year],
        )
      : [];

    const withValues = enrichWithKeeperValues(computePlayerValues(players));
    const playerMap = Object.fromEntries(withValues.map((p) => [p.id, p]));

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
      const rosters = await exec(
        `SELECT * FROM rosters WHERE league_id = $1`,
        [league_id],
      );
      const aRoster = rosters.find((r) => r.roster_id === parseInt(side_a.roster_id));
      const bRoster = rosters.find((r) => r.roster_id === parseInt(side_b.roster_id));

      if (aRoster && bRoster) {
        const aAllIds = aRoster.player_ids ?? [];
        const bAllIds = bRoster.player_ids ?? [];
        const allRosterIds = [...new Set([...aAllIds, ...bAllIds])];

        const rosterPlayers = allRosterIds.length
          ? await exec(
              `SELECT * FROM vw_players WHERE id = ANY($1::text[]) AND year = $2`,
              [allRosterIds, year],
            )
          : [];
        const enrichedRosterPlayers = enrichWithKeeperValues(computePlayerValues(rosterPlayers));
        const rosterPlayerMap = Object.fromEntries(enrichedRosterPlayers.map((p) => [p.id, p]));

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

// Keeper-league pick discount: picks are worth less when top 96 players are kept
const KEEPER_PICK_DISCOUNT = 0.55;

export const findDeals = async (req, res) => {
  try {
    const { player_id, roster_id, league_id, deal_pref } = req.body;
    const { year = new Date().getFullYear() } = req.query;

    if (!player_id || !roster_id || !league_id) {
      return res.status(400).json({ message: "player_id, roster_id, and league_id are required" });
    }

    // 1. Fetch rosters with owner names
    const rosters = await exec(
      `SELECT r.*, u.display_name
       FROM rosters r
       LEFT JOIN league_users u ON u.user_id = r.owner_id AND u.league_id = r.league_id
       WHERE r.league_id = $1`,
      [league_id],
    );

    const myRoster = rosters.find((r) => r.roster_id === parseInt(roster_id));
    if (!myRoster) return res.status(404).json({ message: "Roster not found" });

    // 2. Fetch + enrich all rostered players
    const allPlayerIds = [...new Set(rosters.flatMap((r) => r.player_ids ?? []))];
    const players = allPlayerIds.length
      ? await exec(
          `SELECT * FROM vw_players WHERE id = ANY($1::text[]) AND year = $2 AND position IN ('QB','RB','WR','TE')`,
          [allPlayerIds, year],
        )
      : [];

    const withValues = enrichWithKeeperValues(computePlayerValues(players));
    const playerMap = Object.fromEntries(withValues.map((p) => [p.id, p]));

    const selectedPlayer = playerMap[player_id];
    if (!selectedPlayer) return res.status(404).json({ message: "Player not found" });

    // Determine if this is a sell (own player) or buy (other team's player)
    const ownerRosterId = rosters.find((r) =>
      (r.player_ids ?? []).includes(player_id),
    )?.roster_id;
    const isSelling = ownerRosterId === parseInt(roster_id);

    // 3. Keeper-worthy pool (top 96 by bfbValue)
    const sorted = [...withValues].sort((a, b) => (b.bfbValue ?? 0) - (a.bfbValue ?? 0));
    const keeperWorthyIds = new Set(sorted.slice(0, KEEPER_POOL).map((p) => p.id));

    // 4. Build per-team analysis
    const teams = rosters.map((roster) => {
      const rosterPlayers = (roster.player_ids ?? [])
        .map((id) => playerMap[id])
        .filter(Boolean)
        .sort((a, b) => (b.bfbValue ?? 0) - (a.bfbValue ?? 0));

      const keeperWorthy = rosterPlayers.filter((p) => keeperWorthyIds.has(p.id));
      const surplus = keeperWorthy.length > KEEPER_SLOTS
        ? keeperWorthy.slice(KEEPER_SLOTS)
        : [];

      // Positional needs
      const byPos = {};
      for (const pos of Object.keys(STARTER_COUNTS)) {
        byPos[pos] = keeperWorthy.filter((p) => p.position === pos);
      }
      const needs = [];
      for (const [pos, count] of Object.entries(STARTER_COUNTS)) {
        if ((byPos[pos]?.length ?? 0) < count) needs.push(pos);
      }

      return {
        roster_id: roster.roster_id,
        display_name: roster.display_name || `Team ${roster.roster_id}`,
        players: rosterPlayers,
        keeperWorthy,
        surplus,
        needs,
        byPos,
      };
    });

    const myTeam = teams.find((t) => t.roster_id === parseInt(roster_id));
    const selectedValue = selectedPlayer.bfbValue ?? 0;

    // 5. Pick slot map for valuing picks
    const { rosterToSlot } = await getPickSlotMap(league_id);

    // Fetch draft picks
    const draftPicks = await exec(
      `SELECT * FROM draft_picks WHERE league_id = $1`,
      [league_id],
    );

    // Helper: get discounted pick value for deal generation
    const dealPickValue = (pick) =>
      Math.round(getPickValue(pick.round, rosterToSlot[pick.original_roster_id] ?? 6, pick.season > year ? 1 : 0) * KEEPER_PICK_DISCOUNT);

    // 6. Generate deals

    // Helper: what would a team's 8th-best keeper value be if a player is removed?
    const getPostTradeFloor = (team, removedPlayer) => {
      const remaining = team.keeperWorthy
        .filter((p) => p.id !== removedPlayer.id)
        .sort((a, b) => (b.bfbValue ?? 0) - (a.bfbValue ?? 0));
      return remaining.length >= KEEPER_SLOTS
        ? remaining[KEEPER_SLOTS - 1].bfbValue ?? 0
        : 0;
    };

    // Helper: would the other team's keeper core improve if they trade away `give`
    // and receive `incoming` (the selected player)?
    const tradeImprovesTeam = (team, give, incoming) => {
      const giveIds = new Set(Array.isArray(give) ? give.map((p) => p.id) : [give.id]);
      const remaining = team.players
        .filter((p) => !giveIds.has(p.id))
        .concat(incoming)
        .sort((a, b) => (b.bfbValue ?? 0) - (a.bfbValue ?? 0));
      const newTop8Value = remaining.slice(0, KEEPER_SLOTS).reduce((s, p) => s + (p.bfbValue ?? 0), 0);
      const oldTop8Value = team.players
        .sort((a, b) => (b.bfbValue ?? 0) - (a.bfbValue ?? 0))
        .slice(0, KEEPER_SLOTS)
        .reduce((s, p) => s + (p.bfbValue ?? 0), 0);
      return newTop8Value >= oldTop8Value;
    };

    // Helper: get tradeable players from a team — any player they'd rationally trade
    // for the incoming player (trade improves their keeper core)
    const getTradeablePlayers = (team, incomingPlayer) => {
      return team.players.filter((p) => {
        if (p.id === incomingPlayer.id) return false;
        return tradeImprovesTeam(team, p, incomingPlayer);
      });
    };

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
            .map((p) => ({ ...p, pick_value: dealPickValue(p) }))
            .sort((a, b) => b.pick_value - a.pick_value);

          let picksToInclude = [];
          let pickTotal = 0;
          for (const pick of valuedPicks) {
            if (pickTotal >= gap * 1.1) break;
            picksToInclude.push(pick);
            pickTotal += pick.pick_value;
            if (picksToInclude.length >= 2) break;
          }

          if (pickTotal >= gap * 0.6) {
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
                picks: picksToInclude.map((p) => formatPick(p, rosterToSlot, KEEPER_PICK_DISCOUNT)),
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
          .map((p) => ({ ...p, pick_value: dealPickValue(p) }))
          .sort((a, b) => b.pick_value - a.pick_value);

        let picksToInclude = [];
        let pickTotal = 0;
        for (const pick of valuedPicks) {
          if (pickTotal >= gap * 1.1) break;
          picksToInclude.push(pick);
          pickTotal += pick.pick_value;
          if (picksToInclude.length >= 2) break;
        }

        if (pickTotal >= gap * 0.6) {
          const fairness = computeFairness(
            [basePlayer.bfbValue ?? 0], pickTotal, 1,
            [selectedValue], 0, 1 + picksToInclude.length,
          );
          deals.push({
            target_team: { roster_id: sellerTeam.roster_id, display_name: sellerTeam.display_name },
            type: "player_plus_picks",
            give: {
              players: [formatPlayer(basePlayer)],
              picks: picksToInclude.map((p) => formatPick(p, rosterToSlot, KEEPER_PICK_DISCOUNT)),
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

    // 7. Filter by deal preference
    const filteredDeals = !deal_pref || deal_pref === "any"
      ? deals
      : deals.filter((d) => {
          if (deal_pref === "players_only") return d.type === "player_for_player" || d.type === "multi_player";
          if (deal_pref === "player_plus_picks") return d.type === "player_plus_picks";
          return true;
        });

    // 8. Score and rank — prefer fairest deals, limit to 4
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
  };
}

function formatPick(pick, rosterToSlot, discount = 1) {
  const slot = rosterToSlot[pick.original_roster_id] ?? 6;
  return {
    round: pick.round,
    season: pick.season,
    original_roster_id: pick.original_roster_id,
    current_roster_id: pick.current_roster_id,
    estimated_slot: slot,
    pick_value: Math.round(getPickValue(pick.round, slot, pick.season > new Date().getFullYear() ? 1 : 0) * discount),
  };
}

function computeFairness(aValues, aPickVal, bAssetCount, bValues, bPickVal, aAssetCount) {
  const aSide = calculateTradeValue(aValues, aPickVal, bAssetCount);
  const bSide = calculateTradeValue(bValues, bPickVal, aAssetCount);
  const total = aSide.total + bSide.total || 1;
  return Math.round((aSide.total / total) * 100);
}

export const getTradeTargets = async (req, res) => {
  try {
    const { leagueId, rosterId } = req.params;
    const { year = new Date().getFullYear() } = req.query;

    const rosters = await exec(`SELECT * FROM rosters WHERE league_id = $1`, [
      leagueId,
    ]);
    const myRoster = rosters.find((r) => r.roster_id === parseInt(rosterId));
    if (!myRoster) return res.status(404).json({ message: "Roster not found" });

    const allPlayerIds = [
      ...new Set(rosters.flatMap((r) => r.player_ids ?? [])),
    ];
    const players = await exec(
      `SELECT * FROM vw_players WHERE id = ANY($1::text[]) AND year = $2 AND position IN ('QB','RB','WR','TE')`,
      [allPlayerIds, year],
    );

    const withValues = enrichWithKeeperValues(computePlayerValues(players));

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
