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
// Perceived-value curve: reflects market/trade value, not expected production.
// Round 1 is deliberately flat (a "first rounder" carries prestige).
// Sharp cliff between round 1 and 2 captures the psychological round premium.
// Future picks depreciate at 80%/year.

const PICK_FUTURE_DEPRECIATION = 0.8;
const LEAGUE_SIZE = 12;

// Per-slot values for rounds 1-3 (slots 1-12). Index 0 = slot 1.
// Scaled to sit below elite player values — in a keeper league the draft
// pool is the ~97th+ best players, so picks shouldn't rival top assets.
const ROUND_1_VALUES = [5500, 5200, 4900, 4600, 4250, 3900, 3600, 3300, 3100, 2900, 2750, 2600];
const ROUND_2_VALUES = [1800, 1650, 1500, 1400, 1300, 1150, 1000, 850, 725, 650, 575, 500];
const ROUND_3_VALUES = [450, 425, 400, 385, 370, 350, 325, 300, 280, 265, 255, 250];

const PICK_ROUND_VALUES = { 1: ROUND_1_VALUES, 2: ROUND_2_VALUES, 3: ROUND_3_VALUES };

// Flat per-round values for rounds 4-8
const LATE_ROUND_VALUES = { 4: 200, 5: 150, 6: 100, 7: 75, 8: 50 };

export const getPickValue = (round, slot, yearsOut = 0) => {
  const clampedSlot = Math.max(1, Math.min(slot, LEAGUE_SIZE));
  const roundValues = PICK_ROUND_VALUES[round];

  let base;
  if (roundValues) {
    base = roundValues[clampedSlot - 1];
  } else {
    base = LATE_ROUND_VALUES[round] ?? 50;
  }

  return Math.round(base * Math.pow(PICK_FUTURE_DEPRECIATION, yearsOut));
};

// ── Pick Consolidation Penalty ──────────────────────────────────────────
// When multiple picks are combined to match one pick's value, the package
// is worth less than the sum of parts — you always overpay to trade up.
const CONSOLIDATION_DISCOUNT = { 1: 1.0, 2: 0.85, 3: 0.70 };

export const applyConsolidationDiscount = (totalPickValue, pickCount) => {
  if (pickCount <= 1) return totalPickValue;
  const factor = CONSOLIDATION_DISCOUNT[Math.min(pickCount, 3)] ?? 0.70;
  return Math.round(totalPickValue * factor);
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
