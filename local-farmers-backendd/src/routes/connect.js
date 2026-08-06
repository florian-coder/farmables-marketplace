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
    return 'Nu ai încă un cont de plată. Apasă „Configurează plățile" ca să îl creezi la Stripe.';
  }
  if (!state.detailsSubmitted) {
    return 'Onboardingul Stripe nu e finalizat. Reia-l ca să poți primi bani.';
  }
  if (!state.chargesEnabled) {
    return 'Stripe încă verifică datele tale. Produsele tale nu apar în magazin până când verificarea se încheie.';
  }
  if (state.requirementsDue.length > 0) {
    return 'Stripe cere documente sau informații suplimentare. Deschide-ți contul Stripe ca să le completezi.';
  }
  if (!state.payoutSettingsSet) {
    return 'Setează taxa de livrare și comanda minimă ca să știe clienții la ce să se aștepte.';
  }
  return 'Contul tău de plată este activ.';
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
        error: 'Profilul de fermă nu e încă aprobat. Plățile se configurează după aprobare.',
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
        error: 'Profilul fermei trebuie aprobat de administrator înainte de configurarea plăților.',
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
      return res.status(409).json({ error: 'Nu ai încă un cont Stripe configurat.' });
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
      return res.status(404).json({ error: 'Profilul de fermă nu a fost găsit.' });
    }

    const parseAmount = (value, label) => {
      if (value === null || value === undefined || value === '') {
        return { value: 0 };
      }
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 0) {
        return { problem: `${label} trebuie să fie un număr pozitiv sau zero.` };
      }
      if (parsed > 100000000) {
        return { problem: `${label} este nerealist de mare.` };
      }
      return { value: Math.round(parsed) };
    };

    const fee = parseAmount(req.body?.deliveryFeeBani, 'Taxa de livrare');
    const minimum = parseAmount(req.body?.minOrderValueBani, 'Comanda minimă');
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
      const parsed = parseAmount(rawThreshold, 'Pragul de livrare gratuită');
      if (parsed.problem) {
        return res.status(400).json({ error: parsed.problem });
      }
      threshold = parsed.value > 0 ? parsed.value : null;
    }

    if (threshold !== null && minimum.value > 0 && threshold < minimum.value) {
      return res.status(400).json({
        error: `Pragul de livrare gratuită (${formatBani(threshold)}) nu poate fi sub comanda minimă (${formatBani(minimum.value)}).`,
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
