import { exec } from "../db.js";

/**
 * Returns a roster_id -> slot mapping for pick slot estimation.
 * Prefers the real draft order from Sleeper (offseason) over standings-based approximation (in-season).
 */
export const getPickSlotMap = async (leagueId) => {
  const leagues = await exec(`SELECT draft_order, total_rosters FROM leagues WHERE id = $1`, [leagueId]);
  const league = leagues[0];

  const draftOrder = league?.draft_order;
  if (draftOrder && Object.keys(draftOrder).length > 0) {
    // Sleeper slot_to_roster_id: { "1": roster_id, "2": roster_id, ... }
    // Invert to: roster_id -> slot
    const rosterToSlot = {};
    for (const [slot, rosterId] of Object.entries(draftOrder)) {
      rosterToSlot[parseInt(rosterId)] = parseInt(slot);
    }
    return { rosterToSlot, totalRosters: Object.keys(draftOrder).length, source: "draft_order" };
  }

  // Fall back to current standings — last place = slot 1
  const standings = await exec(
    `SELECT roster_id,
            RANK() OVER (ORDER BY wins ASC, points_for ASC) AS slot,
            COUNT(*) OVER () AS total_rosters
     FROM rosters WHERE league_id = $1`,
    [leagueId],
  );

  const totalRosters = parseInt(standings[0]?.total_rosters ?? 12);
  const rosterToSlot = Object.fromEntries(
    standings.map((s) => [parseInt(s.roster_id), parseInt(s.slot)]),
  );
  return { rosterToSlot, totalRosters, source: "standings" };
};
