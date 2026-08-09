// "Set up payouts" — the Stripe Connect onboarding flow.
//
// This flow had no test at all, and it showed: a farmer whose stored
// `stripe_account_id` no longer resolved at Stripe was stuck permanently.
// `ensureConnectAccount` saw an id on the row, returned it without checking,
// and the account link call then failed against an account that was not
// there. Every subsequent click repeated exactly the same failure, and the
// only visible symptom was a generic "the payment could not be processed" —
// which is not even about payouts.
//
// An account id can die for ordinary reasons: deleted in the Stripe
// dashboard, or created under test keys that were later swapped for live
// ones. So the recovery case gets as much attention here as the happy path.

const request = require('supertest');

const { buildApp, browserHeaders, sessionCookieFor } = require('../helpers/appHarness');
const { createFakeStripe } = require('../helpers/fakeStripe');

const VENDOR = { id: '77', role: 'vendor', tokenVersion: 0 };
const CUSTOMER = { id: '10', role: 'customer', tokenVersion: 0 };

const seed = (farmer = {}) => ({
  users: [
    { id: '77', username: 'ferma', email: 'ferma@example.com', user_type: 'farmer', token_version: 0 },
    { id: '10', username: 'ana', email: 'ana@example.com', user_type: 'client', token_version: 0 },
  ],
  farmers: [
    {
      id: '77',
      'farm name': 'Gradina Verde',
      'display name': 'Gradina',
      email: 'ferma@example.com',
      stripe_account_id: null,
      charges_enabled: false,
      payouts_enabled: false,
      details_submitted: false,
      requirements_due: [],
      delivery_fee_bani: 0,
      min_order_value_bani: 0,
      free_delivery_threshold_bani: null,
      ...farmer,
    },
  ],
});

const farmerRow = (fake) => fake._db.farmers[0];

const onboard = async (app, cookie) =>
  request(app).post('/api/connect/onboard').set(browserHeaders).set('Cookie', cookie).send({});

describe('Set up payouts — creating the account', () => {
  it('creates a Stripe account, records it, and returns an onboarding link', async () => {
    const stripe = createFakeStripe();
    const { app, fake } = buildApp(seed(), { stripe });
    const cookie = await sessionCookieFor(VENDOR);

    const response = await onboard(app, cookie);

    expect(response.status).toBe(200);
    expect(response.body.url).toContain('https://stripe.test/onboarding/');

    // The account exists at Stripe...
    expect(stripe._calls.accountsCreated).toHaveLength(1);
    const [created] = stripe._calls.accountsCreated;
    expect(created.params.type).toBe('express');
    expect(created.params.country).toBe('RO');
    expect(created.params.capabilities.transfers).toEqual({ requested: true });
    // ...and carries the id that lets `account.updated` find the row again.
    expect(created.params.metadata.farmer_id).toBe('77');

    // ...and we recorded it, which is what makes the next click a resume
    // rather than a second account.
    expect(farmerRow(fake).stripe_account_id).toBe(response.body.accountId);
  });

  it('a second click resumes the same account instead of creating another', async () => {
    const stripe = createFakeStripe({ accounts: ['acct_existing'] });
    const { app, fake } = buildApp(seed({ stripe_account_id: 'acct_existing' }), { stripe });
    const cookie = await sessionCookieFor(VENDOR);

    const response = await onboard(app, cookie);

    expect(response.status).toBe(200);
    expect(response.body.accountId).toBe('acct_existing');
    expect(stripe._calls.accountsCreated).toHaveLength(0);
    expect(farmerRow(fake).stripe_account_id).toBe('acct_existing');
  });

  /**
   * The failure this whole flow was stuck on.
   *
   * The row claims an account that Stripe has never heard of. Before, that
   * was terminal. Now the dead id is cleared and a fresh account is created,
   * so the farmer's next click actually gets them somewhere.
   */
  it('recovers when the stored account no longer exists at Stripe', async () => {
    const stripe = createFakeStripe({ accounts: [] });
    const { app, fake } = buildApp(
      seed({
        stripe_account_id: 'acct_deleted',
        // The farm was sellable on the strength of an account that is gone.
        charges_enabled: true,
        details_submitted: true,
      }),
      { stripe },
    );
    const cookie = await sessionCookieFor(VENDOR);

    const response = await onboard(app, cookie);

    expect(response.status).toBe(200);
    expect(stripe._calls.accountsCreated).toHaveLength(1);

    const row = farmerRow(fake);
    expect(row.stripe_account_id).not.toBe('acct_deleted');
    expect(row.stripe_account_id).toBe(response.body.accountId);
    // The capabilities belonged to the dead account and must not survive it:
    // a farm left visible with nowhere to send the money would take orders
    // it cannot be paid for.
    expect(row.charges_enabled).toBe(false);
    expect(row.details_submitted).toBe(false);
  });

  it('the recovery uses a fresh idempotency key, not the dead account’s', async () => {
    const stripe = createFakeStripe({ accounts: [] });
    const { app } = buildApp(seed({ stripe_account_id: 'acct_deleted' }), { stripe });
    const cookie = await sessionCookieFor(VENDOR);

    await onboard(app, cookie);

    // Reusing `connect-account-77` would make Stripe replay the response that
    // created the account we just discarded.
    expect(stripe._calls.accountsCreated[0].options.idempotencyKey).toBe(
      'connect-account-77-after-acct_deleted',
    );
  });

  /**
   * A Stripe outage looks nothing like a deleted account, and must not be
   * treated as one: throwing away a perfectly good account id because a
   * request timed out would orphan the farmer's real Stripe account.
   */
  it('does not discard the account when Stripe is merely unreachable', async () => {
    const stripe = createFakeStripe({
      accounts: ['acct_existing'],
      failures: { accountRetrieve: 'api_error' },
    });
    const { app, fake } = buildApp(seed({ stripe_account_id: 'acct_existing' }), { stripe });
    const cookie = await sessionCookieFor(VENDOR);

    const response = await onboard(app, cookie);

    expect(response.status).toBe(200);
    expect(stripe._calls.accountsCreated).toHaveLength(0);
    expect(farmerRow(fake).stripe_account_id).toBe('acct_existing');
  });

  it('sends the farmer back to the page the payout card is actually on', async () => {
    const stripe = createFakeStripe();
    const { app } = buildApp(seed(), { stripe });
    const cookie = await sessionCookieFor(VENDOR);

    await onboard(app, cookie);

    const [link] = stripe._calls.accountLinks;
    // `/vendor` only redirects to `/profile`, and the redirect drops the
    // `?stripe=` marker the card reads to refresh itself on return.
    expect(link.return_url).toBe('http://localhost:5173/profile?stripe=return');
    expect(link.refresh_url).toBe('http://localhost:5173/profile?stripe=refresh');
    expect(link.type).toBe('account_onboarding');
  });
});

describe('Set up payouts — what the farmer is told when it fails', () => {
  it('explains a Stripe failure in terms of payouts, not payments', async () => {
    const stripe = createFakeStripe({ failures: { accountCreate: 'account_invalid' } });
    const { app } = buildApp(seed(), { stripe });
    const cookie = await sessionCookieFor(VENDOR);

    const response = await onboard(app, cookie);

    expect(response.status).toBe(502);
    // The old text was "The payment could not be processed", which tells a
    // farmer setting up payouts that something went wrong with a customer's
    // money. It did not.
    expect(response.body.error).not.toMatch(/payment could not be processed/i);
    expect(response.body.error).toMatch(/payout/i);
  });

  /**
   * The one the platform operator has to act on, not the farmer.
   *
   * Stripe's real wording is "You can only create new accounts if you've
   * signed up for Connect, which you can do at
   * https://dashboard.stripe.com/connect." The first version of this mapper
   * looked for "not enabled" and "platform profile", matched neither, and
   * handed the farmer a raw string about creating accounts they never asked
   * to create.
   */
  it('names the platform’s own missing Connect signup instead of blaming the farmer', async () => {
    const stripe = createFakeStripe();
    stripe.accounts.create = async () => {
      const error = new Error(
        "You can only create new accounts if you've signed up for Connect, which you can do at " +
          'https://dashboard.stripe.com/connect.',
      );
      error.type = 'StripeInvalidRequestError';
      throw error;
    };
    const { app } = buildApp(seed(), { stripe });
    const cookie = await sessionCookieFor(VENDOR);

    const response = await onboard(app, cookie);

    expect(response.status).toBe(502);
    expect(response.body.error).toMatch(/on our side, not yours/i);
    // And emphatically not the raw Stripe sentence, which reads to a farmer
    // as though they did something wrong.
    expect(response.body.error).not.toMatch(/you can only create new accounts/i);
  });

  it('passes through Stripe’s own wording when it is the actionable part', async () => {
    const stripe = createFakeStripe({ failures: { accountCreate: 'parameter_invalid_empty' } });
    const { app } = buildApp(seed(), { stripe });
    const cookie = await sessionCookieFor(VENDOR);

    const response = await onboard(app, cookie);

    expect(response.status).toBe(502);
    expect(response.body.error).toContain('account create failed');
  });
});

describe('Set up payouts — who may do it', () => {
  it('rejects a signed-out visitor', async () => {
    const { app } = buildApp(seed(), { stripe: createFakeStripe() });

    const response = await request(app)
      .post('/api/connect/onboard')
      .set(browserHeaders)
      .send({});

    expect(response.status).toBe(401);
  });

  it('rejects a customer', async () => {
    const stripe = createFakeStripe();
    const { app } = buildApp(seed(), { stripe });
    const cookie = await sessionCookieFor(CUSTOMER);

    const response = await onboard(app, cookie);

    expect(response.status).toBe(403);
    expect(stripe._calls.accountsCreated).toHaveLength(0);
  });

  it('rejects a vendor whose farm has not been approved yet', async () => {
    const stripe = createFakeStripe();
    const { app } = buildApp({ ...seed(), farmers: [] }, { stripe });
    const cookie = await sessionCookieFor(VENDOR);

    const response = await onboard(app, cookie);

    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/approved/i);
    expect(stripe._calls.accountsCreated).toHaveLength(0);
  });

  it('refuses a request without the browser’s anti-CSRF header', async () => {
    const stripe = createFakeStripe();
    const { app } = buildApp(seed(), { stripe });
    const cookie = await sessionCookieFor(VENDOR);

    const response = await request(app)
      .post('/api/connect/onboard')
      .set('Origin', 'https://evil.example')
      .set('Cookie', cookie)
      .send({});

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(stripe._calls.accountsCreated).toHaveLength(0);
  });
});

describe('Set up payouts — status and dashboard', () => {
  it('tells an unconnected farmer exactly what to press', async () => {
    const stripe = createFakeStripe();
    const { app } = buildApp(seed(), { stripe });
    const cookie = await sessionCookieFor(VENDOR);

    const response = await request(app)
      .get('/api/connect/status')
      .set('Cookie', cookie)
      .send();

    expect(response.status).toBe(200);
    expect(response.body.connected).toBe(false);
    expect(response.body.canSell).toBe(false);
    expect(response.body.productsVisible).toBe(false);
    expect(response.body.hint).toMatch(/Set up payouts/i);
  });

  /**
   * The distinction escrow makes visible: an account can be verified enough
   * to sell while Stripe still has payouts to the bank on hold. The money is
   * safe either way, but the farmer needs to know why nothing has landed.
   */
  it('distinguishes "can sell" from "can be paid out"', async () => {
    const stripe = createFakeStripe({
      accounts: [
        {
          id: 'acct_selling',
          charges_enabled: true,
          payouts_enabled: false,
          details_submitted: true,
          requirements: { currently_due: [] },
        },
      ],
    });
    const { app } = buildApp(seed({ stripe_account_id: 'acct_selling' }), { stripe });
    const cookie = await sessionCookieFor(VENDOR);

    const response = await request(app)
      .get('/api/connect/status')
      .set('Cookie', cookie)
      .send();

    expect(response.body.canSell).toBe(true);
    expect(response.body.payoutsEnabled).toBe(false);
    expect(response.body.hint).toMatch(/payouts to your bank/i);
  });

  it('refuses a dashboard link for a farmer with no account', async () => {
    const stripe = createFakeStripe();
    const { app } = buildApp(seed(), { stripe });
    const cookie = await sessionCookieFor(VENDOR);

    const response = await request(app)
      .post('/api/connect/dashboard')
      .set(browserHeaders)
      .set('Cookie', cookie)
      .send({});

    expect(response.status).toBe(409);
    expect(stripe._calls.loginLinks).toHaveLength(0);
  });

  it('returns a one-time dashboard link for a connected farmer', async () => {
    const stripe = createFakeStripe({ accounts: ['acct_existing'] });
    const { app } = buildApp(seed({ stripe_account_id: 'acct_existing' }), { stripe });
    const cookie = await sessionCookieFor(VENDOR);

    const response = await request(app)
      .post('/api/connect/dashboard')
      .set(browserHeaders)
      .set('Cookie', cookie)
      .send({});

    expect(response.status).toBe(200);
    expect(response.body.url).toBe('https://stripe.test/dashboard/acct_existing');
  });
});

describe('Set up payouts — the farmer’s own delivery terms', () => {
  const saveTerms = async (app, cookie, body) =>
    request(app)
      .put('/api/connect/payout-settings')
      .set(browserHeaders)
      .set('Cookie', cookie)
      .send(body);

  it('saves the delivery fee, minimum and free-delivery threshold', async () => {
    const stripe = createFakeStripe({ accounts: ['acct_existing'] });
    const { app, fake } = buildApp(seed({ stripe_account_id: 'acct_existing' }), { stripe });
    const cookie = await sessionCookieFor(VENDOR);

    const response = await saveTerms(app, cookie, {
      deliveryFeeBani: 1500,
      minOrderValueBani: 3000,
      freeDeliveryThresholdBani: 15000,
    });

    expect(response.status).toBe(200);
    const row = farmerRow(fake);
    expect(row.delivery_fee_bani).toBe(1500);
    expect(row.min_order_value_bani).toBe(3000);
    expect(row.free_delivery_threshold_bani).toBe(15000);
    // Stamped, so the card stops nagging about terms that were never set.
    expect(row.payout_settings_set_at).toBeTruthy();
  });

  it('rejects a free-delivery threshold below the minimum order', async () => {
    const stripe = createFakeStripe({ accounts: ['acct_existing'] });
    const { app, fake } = buildApp(seed({ stripe_account_id: 'acct_existing' }), { stripe });
    const cookie = await sessionCookieFor(VENDOR);

    const response = await saveTerms(app, cookie, {
      deliveryFeeBani: 1500,
      minOrderValueBani: 10000,
      freeDeliveryThresholdBani: 5000,
    });

    // A threshold under the minimum is unreachable: nobody can order below
    // the minimum, so the free delivery would never apply.
    expect(response.status).toBe(400);
    expect(farmerRow(fake).payout_settings_set_at).toBeFalsy();
  });

  it('rejects a negative delivery fee', async () => {
    const stripe = createFakeStripe({ accounts: ['acct_existing'] });
    const { app } = buildApp(seed({ stripe_account_id: 'acct_existing' }), { stripe });
    const cookie = await sessionCookieFor(VENDOR);

    const response = await saveTerms(app, cookie, { deliveryFeeBani: -100 });

    expect(response.status).toBe(400);
  });

  it('treats an empty free-delivery threshold as "no threshold", not zero', async () => {
    const stripe = createFakeStripe({ accounts: ['acct_existing'] });
    const { app, fake } = buildApp(seed({ stripe_account_id: 'acct_existing' }), { stripe });
    const cookie = await sessionCookieFor(VENDOR);

    const response = await saveTerms(app, cookie, {
      deliveryFeeBani: 1500,
      freeDeliveryThresholdBani: '',
    });

    expect(response.status).toBe(200);
    // Zero would mean "free delivery on every order", which is the opposite
    // of what an empty field means.
    expect(farmerRow(fake).free_delivery_threshold_bani).toBeNull();
  });
});
