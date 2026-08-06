// The farmer's payout setup: Stripe Connect onboarding and delivery terms.
//
// This replaces the IBAN field that used to live on the profile form. The
// platform no longer sees, stores or validates a bank account — Stripe
// collects it during onboarding, under its own KYC obligations.

const express = require('express');

const { requireVendor } = require('../middleware/auth');
const { supabase, TABLES } = require('../lib/supabase');
const { describeStripeError, stripeRequestId } = require('../lib/stripeClient');
const {
  ensureConnectAccount,
  createOnboardingLink,
  createDashboardLink,
  refreshConnectState,
  fetchFarmerConnectRow,
  mapConnectState,
} = require('../lib/connect');
const { ACTIONS, recordAudit } = require('../lib/audit');
const { toBani, formatBani } = require('../lib/money');

const router = express.Router();

const failConnect = (res, { status = 502, message, logLabel, error }) => {
  console.error(
    `[connect] ${logLabel}:`,
    error?.message || error,
    stripeRequestId(error) ? `stripe_request=${stripeRequestId(error)}` : '',
  );
  return res.status(status).json({ error: message });
};

/** Guidance in Romanian for whatever Stripe still wants from the farmer. */
const requirementHint = (state) => {
  if (!state.connected) {
    return 'You do not have a payout account yet. Press \u201cSet up payouts\u201d to create one at Stripe.';
  }
  if (!state.detailsSubmitted) {
    return 'Stripe onboarding is not finished. Resume it so you can receive money.';
  }
  if (!state.chargesEnabled) {
    return 'Stripe is still verifying your details. Your products stay hidden until the check completes.';
  }
  if (state.requirementsDue.length > 0) {
    return 'Stripe needs extra documents or information. Open your Stripe account to provide them.';
  }
  if (!state.payoutSettingsSet) {
    return 'Set your delivery fee and minimum order so customers know what to expect.';
  }
  return 'Your payout account is active.';
};

const buildStatusPayload = (state) => ({
  ...state,
  hint: requirementHint(state),
  // The one thing the dashboard banner keys on.
  productsVisible: state.chargesEnabled,
});

/** GET /api/connect/status — current payout state, refreshed from Stripe. */
router.get('/status', requireVendor, async (req, res, next) => {
  try {
    const state = await refreshConnectState(req.user.id);
    if (!state) {
      return res.status(404).json({
        error: 'Your farm profile is not approved yet. Payouts are set up after approval.',
      });
    }
    return res.json(buildStatusPayload(state));
  } catch (error) {
    return next(error);
  }
});

/**
 * POST /api/connect/onboard — create the account if needed, return a link.
 *
 * Account Links are single-use and short-lived, so this is called every time
 * the farmer clicks the button, including to resume an interrupted onboarding.
 */
router.post('/onboard', requireVendor, async (req, res, next) => {
  try {
    const { data: farmer, error } = await supabase
      .from(TABLES.farmers)
      .select('id, "farm name", "display name", email, stripe_account_id')
      .eq('id', req.user.id)
      .maybeSingle();

    if (error) {
      return next(new Error(error.message));
    }
    if (!farmer) {
      return res.status(409).json({
        error: 'Your farm profile must be approved by an admin before you can set up payouts.',
      });
    }

    const { data: userRow } = await supabase
      .from(TABLES.users)
      .select('email')
      .eq('id', req.user.id)
      .maybeSingle();

    const { accountId, created } = await ensureConnectAccount({
      farmerId: farmer.id,
      email: farmer.email || userRow?.email || '',
      farmName: farmer['farm name'] || farmer['display name'] || '',
    });

    if (created) {
      await recordAudit({
        req,
        actorType: 'user',
        actorId: req.user.id,
        action: ACTIONS.CONNECT_ACCOUNT_CREATED,
        entityType: 'farmer',
        entityId: farmer.id,
        newValue: accountId,
      });
    }

    const url = await createOnboardingLink(accountId);

    await recordAudit({
      req,
      actorType: 'user',
      actorId: req.user.id,
      action: ACTIONS.CONNECT_ONBOARDING_STARTED,
      entityType: 'farmer',
      entityId: farmer.id,
      newValue: accountId,
    });

    return res.json({ url, accountId });
  } catch (error) {
    if (error?.type?.startsWith?.('Stripe')) {
      return failConnect(res, {
        message: describeStripeError(error),
        logLabel: `onboarding link failed for farmer ${req.user.id}`,
        error,
      });
    }
    return next(error);
  }
});

/** POST /api/connect/dashboard — one-time link into the Stripe Express dashboard. */
router.post('/dashboard', requireVendor, async (req, res, next) => {
  try {
    const row = await fetchFarmerConnectRow(req.user.id);
    if (!row?.stripe_account_id) {
      return res.status(409).json({ error: 'You do not have a Stripe account set up yet.' });
    }

    const url = await createDashboardLink(String(row.stripe_account_id));
    return res.json({ url });
  } catch (error) {
    if (error?.type?.startsWith?.('Stripe')) {
      return failConnect(res, {
        message: describeStripeError(error),
        logLabel: `dashboard link failed for farmer ${req.user.id}`,
        error,
      });
    }
    return next(error);
  }
});

/**
 * PUT /api/connect/payout-settings — the farmer's own delivery terms.
 *
 * Both values are integer bani and both are frozen onto every order at
 * placement time, so raising the fee tomorrow never changes what a customer
 * agreed to pay today.
 */
router.put('/payout-settings', requireVendor, async (req, res, next) => {
  try {
    const row = await fetchFarmerConnectRow(req.user.id);
    if (!row) {
      return res.status(404).json({ error: 'Farm profile not found.' });
    }

    const parseAmount = (value, label) => {
      if (value === null || value === undefined || value === '') {
        return { value: 0 };
      }
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 0) {
        return { problem: `${label} must be a positive number or zero.` };
      }
      if (parsed > 100000000) {
        return { problem: `${label} is unrealistically large.` };
      }
      return { value: Math.round(parsed) };
    };

    const fee = parseAmount(req.body?.deliveryFeeBani, 'The delivery fee');
    const minimum = parseAmount(req.body?.minOrderValueBani, 'The minimum order');
    if (fee.problem) {
      return res.status(400).json({ error: fee.problem });
    }
    if (minimum.problem) {
      return res.status(400).json({ error: minimum.problem });
    }

    // null means "no free-delivery threshold", which is different from 0.
    let threshold = null;
    const rawThreshold = req.body?.freeDeliveryThresholdBani;
    if (rawThreshold !== null && rawThreshold !== undefined && rawThreshold !== '') {
      const parsed = parseAmount(rawThreshold, 'The free-delivery threshold');
      if (parsed.problem) {
        return res.status(400).json({ error: parsed.problem });
      }
      threshold = parsed.value > 0 ? parsed.value : null;
    }

    if (threshold !== null && minimum.value > 0 && threshold < minimum.value) {
      return res.status(400).json({
        error: `The free-delivery threshold (${formatBani(threshold)}) cannot be below the minimum order (${formatBani(minimum.value)}).`,
      });
    }

    const patch = {
      delivery_fee_bani: fee.value,
      min_order_value_bani: minimum.value,
      free_delivery_threshold_bani: threshold,
      payout_settings_set_at: new Date().toISOString(),
    };

    const { error: updateError } = await supabase
      .from(TABLES.farmers)
      .update(patch)
      .eq('id', req.user.id);

    if (updateError) {
      return next(new Error(updateError.message));
    }

    await recordAudit({
      req,
      actorType: 'user',
      actorId: req.user.id,
      action: ACTIONS.PAYOUT_SETTINGS_CHANGED,
      entityType: 'farmer',
      entityId: req.user.id,
      oldValue: `fee=${toBani(row.delivery_fee_bani)};min=${toBani(row.min_order_value_bani)}`,
      newValue: `fee=${fee.value};min=${minimum.value};free=${threshold ?? '-'}`,
    });

    const refreshed = await fetchFarmerConnectRow(req.user.id);
    return res.json(buildStatusPayload(mapConnectState(refreshed)));
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
