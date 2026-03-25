// ── Elite Value Curve ────────────────────────────────────────────────────
// Non-linear scaling so stars are worth exponentially more than role players.
// This is the core mechanism preventing "4 mediocre guys = 1 star" trades.

const ELITE_EXPONENT = 1.65;

// ── Package Tax ──────────────────────────────────────────────────────────
// Penalty applied to the side sending more assets in a trade.
// Prevents quantity-over-quality exploits.
const PACKAGE_TAX = { 0: 0, 1: 0.1, 2: 0.2, 3: 0.3 };

export const getPackageTax = (assetDiff) => {
  const diff = Math.abs(assetDiff);
  if (diff >= 3) return PACKAGE_TAX[3];
  return PACKAGE_TAX[diff] ?? 0;
};

/**
 * Apply the elite value curve to a single bfbValue.
 * Transforms linear values into a non-linear scale where
 * top players are worth disproportionately more.
 *
 * Input: raw bfbValue (0-10000+ range from KTC/keeper model)
 * Output: adjusted trade value on same scale
 */
export const applyEliteCurve = (value, maxValue = 10000) => {
  if (!value || value <= 0) return 0;
  const normalized = Math.min(value / maxValue, 1.0);
  return Math.round(Math.pow(normalized, ELITE_EXPONENT) * maxValue);
};

/**
 * Computes bfbValue for each player.
 * Uses raw KTC value (from dynasty_rankings) as the base.
 */
export const computePlayerValues = (players) => {
  return players.map((player) => {
    const bfbValue = player.value ? Number(player.value) : null;
    return { ...player, bfbValue };
  });
};

// ── Pick Valuation ──────────────────────────────────────────────────────
// Per-pick curve: 1.01 is elite (8000), 1.02-3.12 exponential decay,
// rounds 4-8 flat per-round. Future picks depreciate at 80%/year.

const PICK_FUTURE_DEPRECIATION = 0.8;
const PICK_ELITE_VALUE = 7000; // 1.01
const PICK_DECAY_START = 3200; // 1.02
const PICK_DECAY_END = 300; // 3.12
const LEAGUE_SIZE = 12;

// Flat per-round values for rounds 4-8
const LATE_ROUND_VALUES = { 4: 200, 5: 150, 6: 100, 7: 75, 8: 50 };

export const getPickValue = (round, slot, yearsOut = 0) => {
  const overallPick = (round - 1) * LEAGUE_SIZE + slot;
  let base;

  if (overallPick === 1) {
    // 1.01 — elite tier, stands alone
    base = PICK_ELITE_VALUE;
  } else if (overallPick <= 36) {
    // Picks 1.02 through 3.12: exponential decay
    base =
      PICK_DECAY_START *
      Math.pow(PICK_DECAY_END / PICK_DECAY_START, (overallPick - 2) / 34);
  } else {
    // Rounds 4-8: flat per-round value
    base = LATE_ROUND_VALUES[round] ?? 50;
  }

  return Math.round(base * Math.pow(PICK_FUTURE_DEPRECIATION, yearsOut));
};

// ── Trade Value Aggregation ─────────────────────────────────────────────

/**
 * Calculate trade side value with elite curve + package tax.
 *
 * @param {number[]} values - sorted desc bfbValues for one side's players
 * @param {number} pickValue - total pick value for this side
 * @param {number} otherSideAssetCount - number of assets on the OTHER side
 * @returns {{ total, rawTotal, taxRate, taxApplied }}
 */
export const calculateTradeValue = (
  values,
  pickValue = 0,
  otherSideAssetCount = 0,
  globalMax = null,
) => {
  const maxVal = globalMax ?? Math.max(...values, pickValue, 1);

  const curvedValues = values.map((v) => applyEliteCurve(v, maxVal));
  const rawPlayerTotal = curvedValues.reduce((sum, v) => sum + v, 0);
  const curvedPickValue =
    pickValue > 0 ? applyEliteCurve(pickValue, maxVal) : 0;
  const rawTotal = rawPlayerTotal + curvedPickValue;

  const myAssets = values.length + (pickValue > 0 ? 1 : 0);
  const assetDiff = myAssets - otherSideAssetCount;
  const taxRate = assetDiff > 0 ? getPackageTax(assetDiff) : 0;
  const taxApplied = taxRate > 0;
  const total = Math.round(rawTotal * (1 - taxRate));

  return { total, rawTotal: Math.round(rawTotal), taxRate, taxApplied };
};
