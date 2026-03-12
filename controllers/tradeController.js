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
        const slot = rosterToSlot[pick.current_roster_id] ?? 6;
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

    const winner = fairness > 52 ? "side_a" : fairness < 48 ? "side_b" : "even";

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
