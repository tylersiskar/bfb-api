import { exec } from "../db.js";
import {
  computePlayerValues,
  getPickValue,
} from "../utils/calculations.js";
import { getPickSlotMap } from "../utils/pickSlots.js";

export const getRosters = async (req, res) => {
  try {
    const { leagueId } = req.params;
    const { year = new Date().getFullYear() } = req.query;

    const rosters = await exec(
      `SELECT r.*, u.display_name, u.avatar
       FROM rosters r
       LEFT JOIN league_users u ON u.roster_id = r.roster_id AND u.league_id = r.league_id
       WHERE r.league_id = $1
       ORDER BY r.wins DESC, r.points_for DESC`,
      [leagueId],
    );

    const picks = await exec(
      `SELECT * FROM draft_picks WHERE league_id = $1 ORDER BY season, round, original_roster_id`,
      [leagueId],
    );

    const ranked = rosters.map((r, i) => ({ ...r, rank: i + 1 }));
    const { rosterToSlot } = await getPickSlotMap(leagueId);

    const picksWithValues = picks.map((pick) => {
      const slot = rosterToSlot[pick.current_roster_id] ?? null;
      return {
        ...pick,
        estimated_slot: slot,
        pick_value: slot ? getPickValue(pick.round, slot) : null,
      };
    });

    const allPlayerIds = [
      ...new Set(ranked.flatMap((r) => r.player_ids ?? [])),
    ];
    const players = allPlayerIds.length
      ? await exec(
          `SELECT * FROM vw_players WHERE id = ANY($1::text[]) AND year = $2`,
          [allPlayerIds, year],
        )
      : [];
    const playerMap = Object.fromEntries(players.map((p) => [p.id, p]));

    const enriched = ranked.map((roster) => ({
      ...roster,
      players: (roster.player_ids ?? []).map((id) => playerMap[id] ?? { id }),
      draft_picks: picksWithValues.filter(
        (p) => p.current_roster_id === roster.roster_id,
      ),
    }));

    res.json(enriched);
  } catch (error) {
    console.error("Error fetching rosters:", error);
    res.status(500).send({ error, message: "Internal Server Error" });
  }
};

export const getStandings = async (req, res) => {
  try {
    const data = await exec(
      `SELECT r.roster_id, r.wins, r.losses, r.ties, r.points_for, u.display_name, u.avatar,
              RANK() OVER (ORDER BY r.wins DESC, r.points_for DESC) AS rank
       FROM rosters r
       LEFT JOIN league_users u ON u.roster_id = r.roster_id AND u.league_id = r.league_id
       WHERE r.league_id = $1`,
      [req.params.leagueId],
    );
    res.json(data);
  } catch (error) {
    console.error("Error fetching standings:", error);
    res.status(500).send({ error, message: "Internal Server Error" });
  }
};

export const getDraftPicks = async (req, res) => {
  try {
    const { leagueId } = req.params;

    const [picks, { rosterToSlot, source }] = await Promise.all([
      exec(
        `SELECT dp.*, u.display_name AS current_owner_name
         FROM draft_picks dp
         LEFT JOIN league_users u ON u.roster_id = dp.current_roster_id AND u.league_id = dp.league_id
         WHERE dp.league_id = $1
         ORDER BY dp.season, dp.round, dp.original_roster_id`,
        [leagueId],
      ),
      getPickSlotMap(leagueId),
    ]);

    const result = picks.map((pick) => {
      const slot = rosterToSlot[pick.current_roster_id] ?? null;
      return {
        ...pick,
        estimated_slot: slot,
        pick_value: slot ? getPickValue(pick.round, slot) : null,
        slot_source: source,
      };
    });

    res.json(result);
  } catch (error) {
    console.error("Error fetching draft picks:", error);
    res.status(500).send({ error, message: "Internal Server Error" });
  }
};

export const getKeeperScores = async (req, res) => {
  try {
    const { year = new Date().getFullYear() } = req.query;
    const data = await exec(
      `SELECT * FROM vw_players WHERE year = $1 AND position IN ('QB','RB','WR','TE') ORDER BY value DESC`,
      [year],
    );
    const withValues = computePlayerValues(data);
    const sorted = [...withValues].sort((a, b) => b.bfbValue - a.bfbValue);
    const keeperWorthy = new Set(sorted.slice(0, 96).map((p) => p.id));
    res.json(
      withValues.map((p) => ({ ...p, keeperWorthy: keeperWorthy.has(p.id) })),
    );
  } catch (error) {
    console.error("Error fetching keeper scores:", error);
    res.status(500).send({ error, message: "Internal Server Error" });
  }
};
