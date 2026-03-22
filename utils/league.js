import { computePlayerValues } from "./calculations.js";
import { enrichWithKeeperValues } from "./keeperValues.js";

const KEEPER_POOL = 96; // 8 keepers × 12 teams

export function enrichPlayers(players) {
  const withValues = enrichWithKeeperValues(computePlayerValues(players));
  const playerMap = Object.fromEntries(withValues.map((p) => [p.id, p]));
  return { withValues, playerMap };
}

export function getKeeperWorthyIds(valuedPlayers, poolSize = KEEPER_POOL) {
  const sorted = [...valuedPlayers].sort(
    (a, b) => (b.bfbValue ?? 0) - (a.bfbValue ?? 0),
  );
  return new Set(sorted.slice(0, poolSize).map((p) => p.id));
}

export async function fetchSleeperKeepers(leagueId) {
  const keepers = {};
  try {
    const res = await fetch(
      `https://api.sleeper.app/v1/league/${leagueId}/rosters`,
    );
    const rosters = await res.json();
    if (Array.isArray(rosters)) {
      for (const r of rosters) {
        if (Array.isArray(r.keepers) && r.keepers.length > 0) {
          keepers[r.roster_id] = r.keepers;
        }
      }
    }
  } catch (err) {
    console.warn("[sleeper] Failed to fetch keepers:", err.message);
  }
  return keepers;
}
