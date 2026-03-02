// Position-specific weights: how much current production vs dynasty value matters
// KTC dynasty values already price in youth/age, so production leads across positions.
// WR dynasty weight reduced to avoid double-counting the youth premium KTC already encodes.
// const POSITION_WEIGHTS = {
//   QB: { prod: 0.60, dynasty: 0.40 },
//   RB: { prod: 0.55, dynasty: 0.45 },
//   WR: { prod: 0.55, dynasty: 0.45 },
//   TE: { prod: 0.55, dynasty: 0.45 },
// };

// Age/longevity curve — keeper leagues reward youth (years_exp as proxy for age)
// const AGE_FACTOR = (yearsExp) => {
//   if (yearsExp <= 1) return 1.00;
//   if (yearsExp <= 2) return 0.95;
//   if (yearsExp <= 3) return 0.85;
//   if (yearsExp <= 4) return 0.72;
//   if (yearsExp <= 5) return 0.58;
//   if (yearsExp <= 6) return 0.42;
//   return 0.28;
// };

/**
 * Computes bfbValue (0–1000) for each player — a keeper-aware score that combines:
 *   - Current production (PPG percentile within position, adjusted for games played)
 *   - Dynasty trade value (KTC value percentile within position)
 *   - Age/longevity (20% of score rewards youth; dynasty value already prices in the rest)
 *
 * Designed for an 8-player keeper league (12 teams × 8 keepers = 96 keeper slots).
 */
export const computePlayerValues = (players) => {
  return players.map((player) => {
    // TODO: re-enable blended formula once weights are calibrated
    // const { position, ppg_percentile, value_percentile, gms_active, years_exp } = player;
    // const weights = POSITION_WEIGHTS[position];
    // if (!weights) return { ...player, bfbValue: null };

    // // Games factor: penalizes players who missed significant time (injury risk signal)
    // // Players with no season data (pre-debut rookies) get a neutral 0.5
    // const gamesFactor = gms_active ? Math.min(gms_active / 15, 1.0) : 0.5;

    // const production = (ppg_percentile ?? 0) * gamesFactor;
    // const dynasty = value_percentile ?? 0;

    // // Base score: position-weighted blend of production and dynasty value (0–1)
    // const base = weights.prod * production + weights.dynasty * dynasty;

    // // Age multiplier: 80% of score is age-independent, 20% rewards longevity.
    // // Weight reduced from 35% — dynasty value (KTC) already encodes the youth premium,
    // // so a large independent age bonus was double-counting it.
    // const ageFactor = AGE_FACTOR(years_exp ?? 99);
    // const bfbValue = Math.round(base * (0.80 + 0.20 * ageFactor) * 1000);

    // Use raw KTC value from dynasty_rankings as bfbValue for now
    const bfbValue = player.value ? Number(player.value) : null;
    return { ...player, bfbValue };
  });
};

export const getPickValue = (round, slot) => {
  if (round === 1) {
    if (slot <= 4) return 800;
    if (slot <= 8) return 550;
    return 350;
  }
  if (round === 2) return slot <= 6 ? 200 : 120;
  return 80;
};

export const DIMINISHING = [1.0, 0.75, 0.55, 0.40, 0.30];

export const diminishingTotal = (values) =>
  values.reduce((sum, v, i) => sum + v * (DIMINISHING[i] ?? 0.30), 0);
