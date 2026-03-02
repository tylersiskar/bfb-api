import { exec } from "../db.js";
import {
  computePlayerValues,
  getPickValue,
  diminishingTotal,
} from "../utils/calculations.js";
import { getPickSlotMap } from "../utils/pickSlots.js";

const STARTER_COUNTS = { QB: 1, RB: 2, WR: 3, TE: 1 };

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

    const withValues = computePlayerValues(players);
    const playerMap = Object.fromEntries(withValues.map((p) => [p.id, p]));

    const tradeValue = (id) => playerMap[id]?.bfbValue ?? 0;

    // Pick slot map — uses real draft order (offseason) or standings (in-season)
    const { rosterToSlot } = league_id
      ? await getPickSlotMap(league_id)
      : { rosterToSlot: {} };

    const sidePickValue = (picks) =>
      (picks ?? []).reduce((sum, pick) => {
        const slot = rosterToSlot[pick.current_roster_id] ?? 6;
        return sum + getPickValue(pick.round, slot);
      }, 0);

    const sortedValues = (ids) => ids.map(tradeValue).sort((a, b) => b - a);

    const aPlayerValues = sortedValues(side_a.players ?? []);
    const bPlayerValues = sortedValues(side_b.players ?? []);

    const aTotal =
      diminishingTotal(aPlayerValues) + sidePickValue(side_a.picks);
    const bTotal =
      diminishingTotal(bPlayerValues) + sidePickValue(side_b.picks);
    const aBest = aPlayerValues[0] ?? 0;
    const bBest = bPlayerValues[0] ?? 0;

    const maxVal = Math.max(aBest, bBest, aTotal, bTotal, 1);
    const aScore =
      0.6 * (aBest / maxVal) + 0.4 * (aTotal / (aTotal + bTotal || 1));
    const bScore =
      0.6 * (bBest / maxVal) + 0.4 * (bTotal / (aTotal + bTotal || 1));

    const fairness = Math.round((aScore / (aScore + bScore)) * 100);
    const margin =
      Math.abs(fairness - 50) < 5
        ? "even"
        : Math.abs(fairness - 50) < 12
          ? "slight"
          : Math.abs(fairness - 50) < 22
            ? "moderate"
            : "significant";

    res.json({
      fairness,
      winner: fairness > 50 ? "side_a" : fairness < 50 ? "side_b" : "even",
      margin,
      breakdown: {
        best_player_edge:
          aBest > bBest ? "side_a" : bBest > aBest ? "side_b" : "even",
        total_value_edge:
          aTotal > bTotal ? "side_a" : bTotal > aTotal ? "side_b" : "even",
        side_a_value: Math.round(aTotal),
        side_b_value: Math.round(bTotal),
        side_a_picks_value: sidePickValue(side_a.picks),
        side_b_picks_value: sidePickValue(side_b.picks),
      },
      players: withValues.map((p) => ({
        id: p.id,
        full_name: p.full_name,
        position: p.position,
        bfbValue: p.bfbValue,
      })),
    });
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

    const withValues = computePlayerValues(players);

    const myPlayerIds = new Set(myRoster.player_ids ?? []);
    const myPlayers = withValues.filter((p) => myPlayerIds.has(p.id));

    const myByPos = {};
    for (const pos of Object.keys(STARTER_COUNTS)) {
      myByPos[pos] = myPlayers
        .filter((p) => p.position === pos)
        .sort((a, b) => b.bfbValue - a.bfbValue);
    }

    const needScores = {};
    for (const [pos, starters] of Object.entries(STARTER_COUNTS)) {
      const myStarters = myByPos[pos].slice(0, starters);
      const avgValue = myStarters.length
        ? myStarters.reduce((s, p) => s + p.bfbValue, 0) / myStarters.length
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
