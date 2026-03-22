// ── Elite Value Curve ────────────────────────────────────────────────────
// Non-linear scaling so stars are worth exponentially more than role players.
// This is the core mechanism preventing "4 mediocre guys = 1 star" trades.

const ELITE_EXPONENT = 1.65;

// ── Package Tax ──────────────────────────────────────────────────────────
// Penalty applied to the side sending more assets in a trade.
// Prevents quantity-over-quality exploits.
const PACKAGE_TAX = { 0: 0, 1: 0.10, 2: 0.20, 3: 0.30 };

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
// Base values by round + slot tier.
// Future picks depreciate at 80% per year.
// Hit-rate discount: picks bust more often than owners expect.

const PICK_HIT_RATE = 0.70;
const PICK_TOP_HIT_RATE = 0.80;
const PICK_FUTURE_DEPRECIATION = 0.80;

const PICK_BASE = {
  1: { top: 10000, early: 8000, mid: 6000, late: 4000 },
  2: { top: 3000, early: 2400, mid: 1500, late: 1000 },
  3: { top: 1000, early: 750, mid: 600, late: 400 },
};

export const getPickValue = (round, slot, yearsOut = 0) => {
  const roundVals = PICK_BASE[round];
  if (!roundVals) return 200;

  const tier = slot === 1 ? "top" : slot <= 4 ? "early" : slot <= 8 ? "mid" : "late";
  const base = roundVals[tier] ?? 400;
  const hitRate = tier === "top" ? PICK_TOP_HIT_RATE : PICK_HIT_RATE;
  return Math.round(base * hitRate * Math.pow(PICK_FUTURE_DEPRECIATION, yearsOut));
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
export const calculateTradeValue = (values, pickValue = 0, otherSideAssetCount = 0, globalMax = null) => {
  const maxVal = globalMax ?? Math.max(...values, pickValue, 1);

  const curvedValues = values.map((v) => applyEliteCurve(v, maxVal));
  const rawPlayerTotal = curvedValues.reduce((sum, v) => sum + v, 0);
  const curvedPickValue = pickValue > 0 ? applyEliteCurve(pickValue, maxVal) : 0;
  const rawTotal = rawPlayerTotal + curvedPickValue;

  const myAssets = values.length + (pickValue > 0 ? 1 : 0);
  const assetDiff = myAssets - otherSideAssetCount;
  const taxRate = assetDiff > 0 ? getPackageTax(assetDiff) : 0;
  const taxApplied = taxRate > 0;
  const total = Math.round(rawTotal * (1 - taxRate));

  return { total, rawTotal: Math.round(rawTotal), taxRate, taxApplied };
};
