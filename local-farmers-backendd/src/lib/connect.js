// Stripe Connect — the farmer's own Stripe account.
//
// LEG-01: the platform is an intermediary, not the seller and not a bank. The
// customer's card is charged on the platform account; each farmer's share is
// held against their order and moved to their own Connect account by a
// `Transfer` once the customer confirms the order arrived. The hold is short,
// bounded and always owed to one of the two parties — see `lib/transfers.js`.
//
// Express accounts: Stripe runs the KYC, collects the IBAN, and hosts both the
// onboarding form and the farmer's dashboard. That is why the platform no
// longer asks for an IBAN anywhere — collecting it was both a liability and,
// with Connect in place, pointless.

const { supabase, TABLES } = require('./supabase');
const { stripe, CONNECT_ACCOUNT_TYPE, isMissingAccountError } = require('./stripeClient');
const { FRONTEND_URL } = require('./config');

/** Columns describing where a farmer stands with Stripe. */
const CONNECT_COLUMNS = [
  'id',
  'stripe_account_id',
  'charges_enabled',
  'payouts_enabled',
  'details_submitted',
  'requirements_due',
  'onboarding_completed_at',
  'delivery_fee_bani',
  'min_order_value_bani',
  'free_delivery_threshold_bani',
  'payout_settings_set_at',
].join(', ');

const asBool = (value) => value === true || value === 1 || value === '1';

/**
 * The farmer's payout state as the rest of the app needs it: can they sell,
 * what is still missing, and have they set their own delivery terms.
 */
const mapConnectState = (farmer) => {
  const accountId = String(farmer?.stripe_account_id || '');
  const requirements = Array.isArray(farmer?.requirements_due)
    ? farmer.requirements_due
    : Array.isArray(farmer?.requirements_due?.currently_due)
      ? farmer.requirements_due.currently_due
      : [];

  const chargesEnabled = asBool(farmer?.charges_enabled);

  return {
    accountId,
    connected: Boolean(accountId),
    chargesEnabled,
    payoutsEnabled: asBool(farmer?.payouts_enabled),
    detailsSubmitted: asBool(farmer?.details_submitted),
    requirementsDue: requirements.map(String),
    onboardingCompletedAt: farmer?.onboarding_completed_at || null,
    // The single flag every catalog and cart check reads.
    canSell: chargesEnabled,
    deliveryFeeBani: Number(farmer?.delivery_fee_bani || 0),
    minOrderValueBani: Number(farmer?.min_order_value_bani || 0),
    freeDeliveryThresholdBani:
      farmer?.free_delivery_threshold_bani === null ||
      farmer?.free_delivery_threshold_bani === undefined
        ? null
        : Number(farmer.free_delivery_threshold_bani),
    payoutSettingsSet: Boolean(farmer?.payout_settings_set_at),
  };
};

const fetchFarmerConnectRow = async (farmerId) => {
  const { data, error } = await supabase
    .from(TABLES.farmers)
    .select(CONNECT_COLUMNS)
    .eq('id', farmerId)
    .maybeSingle();

  if (error && error.code !== 'PGRST116') {
    throw new Error(error.message || 'Unable to load farmer payout state.');
  }
  return data || null;
};

/**
 * Is the account id we have on file still a real account at Stripe?
 *
 * Called before every onboarding link, because a dead id is the failure that
 * used to make "Set up payouts" permanently useless: the row said the farmer
 * had an account, so nothing ever tried to create one, and every click asked
 * Stripe for a link to an account that was not there. The id can die for
 * ordinary reasons — the account was deleted in the dashboard, or the
 * platform moved from test keys to live ones and the old test accounts are
 * invisible under the new key.
 *
 * Returns the live account, or null if it is gone. A Stripe outage returns
 * the account as unknown rather than null: we must not delete a perfectly
 * good account id because Stripe timed out once.
 */
const verifyStripeAccount = async (accountId) => {
  try {
    const account = await stripe.accounts.retrieve(String(accountId));
    return { exists: true, account };
  } catch (error) {
    if (isMissingAccountError(error)) {
      return { exists: false, account: null };
    }
    // Anything else — network, rate limit, permissions — is not evidence that
    // the account is gone.
    return { exists: true, account: null, unverified: true, error };
  }
};

/** Forget a Stripe account id that no longer resolves, so a new one can be made. */
const clearDeadAccount = async (farmerId, deadAccountId) => {
  console.error(
    `[connect] Farmer ${farmerId} had Stripe account ${deadAccountId}, which no longer exists. ` +
      'Clearing it so onboarding can start over.',
  );

  const { error } = await supabase
    .from(TABLES.farmers)
    .update({
      stripe_account_id: null,
      // The capabilities went with the account. Leaving them true would keep
      // the farm visible in the catalogue with nowhere to send the money.
      charges_enabled: false,
      payouts_enabled: false,
      details_submitted: false,
      requirements_due: [],
      onboarding_completed_at: null,
    })
    .eq('id', farmerId)
    .eq('stripe_account_id', String(deadAccountId));

  if (error) {
    throw new Error('Your payout account could not be reset. Please try again in a moment.');
  }
};

/**
 * Create the farmer's Express account if they do not have a usable one.
 *
 * `metadata.farmer_id` is what lets the `account.updated` webhook find the
 * row again, and it is also the fallback if the id is ever lost on our side.
 */
const ensureConnectAccount = async ({ farmerId, email, farmName, country = 'RO' }) => {
  const existing = await fetchFarmerConnectRow(farmerId);
  const storedId = String(existing?.stripe_account_id || '');

  if (storedId) {
    const check = await verifyStripeAccount(storedId);
    if (check.exists) {
      return { accountId: storedId, created: false, account: check.account };
    }
    await clearDeadAccount(farmerId, storedId);
  }

  const account = await stripe.accounts.create(
    {
      type: CONNECT_ACCOUNT_TYPE,
      country,
      email: email || undefined,
      business_profile: {
        name: farmName || undefined,
        product_description: 'Farm produce sold through the Farmables platform.',
      },
      capabilities: {
        // `transfers` is what the payout needs. `card_payments` is not
        // requested: the customer's card is charged on the platform account,
        // and asking for a capability we never use only adds KYC the farmer
        // would have to satisfy before they could sell anything.
        transfers: { requested: true },
      },
      metadata: { farmer_id: String(farmerId) },
    },
    // Same farmer, same account: a double click cannot create two accounts.
    // The dead account id is part of the key so that a farmer recovering from
    // one does not get Stripe's cached copy of the account we just discarded.
    { idempotencyKey: `connect-account-${farmerId}${storedId ? `-after-${storedId}` : ''}` },
  );

  const { error } = await supabase
    .from(TABLES.farmers)
    .update({
      stripe_account_id: account.id,
      charges_enabled: Boolean(account.charges_enabled),
      payouts_enabled: Boolean(account.payouts_enabled),
      details_submitted: Boolean(account.details_submitted),
      requirements_due: account.requirements?.currently_due || [],
    })
    .eq('id', farmerId);

  if (error) {
    // The Stripe account exists but we failed to record it. Surfacing the id
    // in the log is what makes the manual repair possible.
    console.error(
      `[connect] Account ${account.id} created for farmer ${farmerId} but not saved:`,
      error.message,
    );
    throw new Error('Your Stripe account was created but could not be saved. Please try again.');
  }

  return { accountId: account.id, created: true, account };
};

/**
 * A one-time onboarding link. Account Links expire in minutes and can only be
 * used once, so we mint a fresh one on every click rather than storing it.
 *
 * Both URLs point at `/profile`, which is where the payout card lives — the
 * old `/vendor` target only redirects there, and a redirect is exactly what
 * drops the `?stripe=` marker the card reads to refresh itself on return.
 */
const createOnboardingLink = async (accountId) => {
  const link = await stripe.accountLinks.create({
    account: accountId,
    // `refresh` means the link expired before they finished; the card mints a
    // new one. `return` means Stripe is done with them, which is not the same
    // as approved — the card re-reads the real state either way.
    refresh_url: `${FRONTEND_URL}/profile?stripe=refresh`,
    return_url: `${FRONTEND_URL}/profile?stripe=return`,
    type: 'account_onboarding',
    collection_options: { fields: 'eventually_due' },
  });
  return link.url;
};

/** Link into the hosted Express dashboard, where the farmer sees their payouts. */
const createDashboardLink = async (accountId) => {
  const link = await stripe.accounts.createLoginLink(accountId);
  return link.url;
};

/**
 * Copy Stripe's view of an account onto the farmer row.
 *
 * Called both from the `account.updated` webhook and on demand, because a
 * farmer who has just finished onboarding refreshes the page before the
 * webhook arrives and expects to see the new state.
 */
const syncAccountToFarmer = async (account) => {
  const accountId = String(account?.id || '');
  if (!accountId) {
    return null;
  }

  const chargesEnabled = Boolean(account.charges_enabled);
  const detailsSubmitted = Boolean(account.details_submitted);

  const patch = {
    charges_enabled: chargesEnabled,
    payouts_enabled: Boolean(account.payouts_enabled),
    details_submitted: detailsSubmitted,
    requirements_due: account.requirements?.currently_due || [],
  };

  // Stamped once, the first time the account can actually take money.
  if (chargesEnabled && detailsSubmitted) {
    patch.onboarding_completed_at = new Date().toISOString();
  }

  // Match on the account id; fall back to the metadata we set at creation, in
  // case the column was never written (see ensureConnectAccount).
  const farmerId = account.metadata?.farmer_id;
  let query = supabase.from(TABLES.farmers).update(patch);
  query = farmerId
    ? query.or(`stripe_account_id.eq.${accountId},id.eq.${farmerId}`)
    : query.eq('stripe_account_id', accountId);

  const { error } = await query;
  if (error) {
    throw new Error(error.message || 'Unable to sync Stripe account state.');
  }

  // Who this account belongs to, so the caller can notify them without a
  // second lookup. Read after the update so a first-time link is reflected.
  const { data: owner } = await supabase
    .from(TABLES.farmers)
    .select('id, "farm name", "display name"')
    .eq('stripe_account_id', accountId)
    .maybeSingle();

  return {
    accountId,
    chargesEnabled,
    detailsSubmitted,
    farmerId: owner?.id ? String(owner.id) : farmerId ? String(farmerId) : '',
    farmName: owner?.['farm name'] || owner?.['display name'] || '',
  };
};

/**
 * Refresh from Stripe, then return the stored state. Used by the vendor
 * dashboard so the farmer never sees a stale "not yet approved".
 */
const refreshConnectState = async (farmerId) => {
  const row = await fetchFarmerConnectRow(farmerId);
  if (!row) {
    return null;
  }
  if (!row.stripe_account_id) {
    return mapConnectState(row);
  }

  try {
    const account = await stripe.accounts.retrieve(String(row.stripe_account_id));
    await syncAccountToFarmer(account);
    const refreshed = await fetchFarmerConnectRow(farmerId);
    return mapConnectState(refreshed || row);
  } catch (error) {
    // A Stripe outage must not blank out the dashboard: fall back to what we
    // last recorded, which is what the webhook keeps up to date anyway.
    console.error('[connect] Unable to refresh account state:', error?.message || error);
    return mapConnectState(row);
  }
};

/**
 * Which of these farmer ids can currently be sold from.
 *
 * One query for the whole catalog page, so the visibility gate does not cost
 * a round trip per product.
 */
const fetchSellableFarmerIds = async (farmerIds) => {
  const ids = [...new Set((farmerIds || []).map((value) => String(value || '')).filter(Boolean))];
  if (ids.length === 0) {
    return new Set();
  }

  const { data, error } = await supabase
    .from(TABLES.farmers)
    .select('id, charges_enabled')
    .in('id', ids);

  if (error) {
    throw new Error(error.message || 'Unable to load farmer payout state.');
  }

  return new Set(
    (data || []).filter((row) => asBool(row.charges_enabled)).map((row) => String(row.id)),
  );
};

module.exports = {
  CONNECT_COLUMNS,
  mapConnectState,
  fetchFarmerConnectRow,
  verifyStripeAccount,
  clearDeadAccount,
  ensureConnectAccount,
  createOnboardingLink,
  createDashboardLink,
  syncAccountToFarmer,
  refreshConnectState,
  fetchSellableFarmerIds,
};
