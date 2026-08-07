// Platform-wide configuration that a human changes without a deploy.
//
// The commission rate lives in the database, not in the source, because
// changing it is a business decision and because every order freezes the rate
// it was placed under (`orders.commission_bps`). A rate change must never
// rewrite what a past order was worth.

const { supabase, TABLES } = require('./supabase');

/** Used only when the settings row has not been created yet: 10%. */
const FALLBACK_COMMISSION_BPS = 1000;
/** Stripe refuses RON charges under 2.00 lei. */
const FALLBACK_MIN_CHARGE_BANI = 200;
/** LOG-04 — the ±10% in customer terms §10.4, as a number the code reads. */
const FALLBACK_WEIGHT_TOLERANCE_BPS = 1000;

const CACHE_TTL_MS = 60 * 1000;

let cache = null;
let cachedAt = 0;

const readFromDatabase = async () => {
  const { data, error } = await supabase
    .from(TABLES.platformSettings)
    .select('commission_bps, min_charge_bani, weight_tolerance_bps')
    .eq('id', true)
    .maybeSingle();

  if (error || !data) {
    if (error) {
      console.error('[settings] Unable to read platform_settings:', error.message);
    }
    return {
      commissionBps: FALLBACK_COMMISSION_BPS,
      minChargeBani: FALLBACK_MIN_CHARGE_BANI,
      weightToleranceBps: FALLBACK_WEIGHT_TOLERANCE_BPS,
      fromDatabase: false,
    };
  }

  const bps = Number(data.commission_bps);
  const minCharge = Number(data.min_charge_bani);
  const tolerance = Number(data.weight_tolerance_bps);

  return {
    commissionBps: Number.isFinite(bps) && bps >= 0 ? Math.round(bps) : FALLBACK_COMMISSION_BPS,
    minChargeBani:
      Number.isFinite(minCharge) && minCharge >= 0
        ? Math.round(minCharge)
        : FALLBACK_MIN_CHARGE_BANI,
    weightToleranceBps:
      Number.isFinite(tolerance) && tolerance >= 0
        ? Math.round(tolerance)
        : FALLBACK_WEIGHT_TOLERANCE_BPS,
    fromDatabase: true,
  };
};

/**
 * Current settings, cached for a minute. A rate change is visible on the next
 * cart refresh, which is soon enough — and the frozen value on each order is
 * what actually settles the money.
 */
const getPlatformSettings = async () => {
  if (cache && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cache;
  }
  cache = await readFromDatabase();
  cachedAt = Date.now();
  return cache;
};

/** Drop the cache — used by tests and after an admin edits the rate. */
const invalidatePlatformSettings = () => {
  cache = null;
  cachedAt = 0;
};

module.exports = {
  FALLBACK_COMMISSION_BPS,
  FALLBACK_MIN_CHARGE_BANI,
  FALLBACK_WEIGHT_TOLERANCE_BPS,
  getPlatformSettings,
  invalidatePlatformSettings,
};
