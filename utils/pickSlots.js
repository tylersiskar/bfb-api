import { exec } from "../db.js";

/**
 * Compute draft order from previous season's playoff bracket + rosters.
 * Mirrors the FE logic in standingsSlice.js exactly.
 * Returns a slot_to_roster_id map: { "1": rosterId, ... }
 * where slot 1 = worst team (first pick), slot N = champion (last pick).
 */
export const computeDraftOrderFromBracket = (playoffBracket, rosters) => {
  const standingsSlot = {};

  playoffBracket.forEach((match) => {
    const isConsolationMatch =
      (match.t1_from && match.t1_from.l) || (match.t2_from && match.t2_from.l);

    if (match.w && !isConsolationMatch) {
      if (match.r === 3) {
        standingsSlot[match.w] = 1;  // champion
        standingsSlot[match.l] = 2;  // runner-up
      } else if (match.r === 2) {
        standingsSlot[match.l] = 3;  // lost in semis
      } else if (match.r === 1) {
        standingsSlot[match.l] = 4;  // lost in quarters
      }
    }
  });

  // Sort best-to-worst: playoff teams first (by placement), then non-playoff by wins/points DESC
  const sorted = [...rosters].sort((a, b) => {
    return (
      (standingsSlot[a.roster_id] || Infinity) - (standingsSlot[b.roster_id] || Infinity) ||
      (b.settings?.wins ?? 0) - (a.settings?.wins ?? 0) ||
      ((b.settings?.fpts ?? 0) + (b.settings?.fpts_decimal ?? 0) / 100) -
        ((a.settings?.fpts ?? 0) + (a.settings?.fpts_decimal ?? 0) / 100)
    );
  });

  // Reverse so worst team = slot 1 (first pick), champion = slot N (last pick)
  const reversed = [...sorted].reverse();

  const slotToRosterId = {};
  reversed.forEach((roster, idx) => {
    slotToRosterId[String(idx + 1)] = roster.roster_id;
  });

  return slotToRosterId;
};

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
  // ROW_NUMBER (not RANK) ensures unique slots even when records are tied
  const standings = await exec(
    `SELECT roster_id,
            ROW_NUMBER() OVER (ORDER BY wins ASC, points_for ASC) AS slot,
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
