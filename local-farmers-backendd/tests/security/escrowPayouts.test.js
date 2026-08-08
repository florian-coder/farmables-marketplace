// Escrow payouts — the farmer is paid when the customer confirms receipt.
//
// The property under test is a money invariant, not a status field: between
// the card clearing and the customer confirming, every ban of the farmer's
// share must still be on the platform balance and still refundable in full.
// The old model transferred on payment, which meant a customer who never
// received their order was refunded out of a balance the farmer might
// already have withdrawn — the `refund_pending_manual` path exists because
// of exactly that.
//
// So these go through the real webhook, the real state machine, the real
// refund module and the real maintenance sweep, with only Supabase and
// Stripe replaced. A test that asserted `transfer_state === 'held'` against a
// mock would prove nothing; what has to be proved is that no Stripe transfer
// call happens until the confirmation, and that the amounts add up when one
// finally does.

const request = require('supertest');
const Stripe = require('stripe');

const { buildApp, browserHeaders, sessionCookieFor } = require('../helpers/appHarness');
const { createFakeStripe } = require('../helpers/fakeStripe');
const { orderRpc } = require('../helpers/fakeRpc');

const CUSTOMER = { id: '10', role: 'customer', tokenVersion: 0 };
const VENDOR = { id: '77', role: 'vendor', tokenVersion: 0 };

const WEBHOOK_SECRET = 'whsec_escrow_test_secret';

/** Only for signing test payloads — never talks to Stripe. */
const signer = new Stripe('sk_test_signing_only');

// Set for every test in the file, not restored: `config.js` reads it at boot
// on each `buildApp`, and another suite in the same worker may have left it
// blank. A test that boots the app must not depend on that.
beforeEach(() => {
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
});

/**
 * One farm, one order, 125.00 lei on the customer's card:
 * 100.00 products + 15.00 delivery + 10.00 commission.
 * The farmer is owed 115.00 of it — products plus delivery, never the
 * commission — and under escrow they do not have a ban of it yet.
 */
const OWED_TO_FARMER = 11500;
const CHARGED_TO_CUSTOMER = 12500;

const seed = ({ order = {}, checkout = {}, extra = {} } = {}) => ({
  users: [
    { id: '10', username: 'ana', email: 'ana@example.com', user_type: 'client', token_version: 0 },
    {
      id: '77',
      username: 'ferma',
      email: 'ferma@example.com',
      user_type: 'farmer',
      token_version: 0,
    },
  ],
  customers: [{ id: '10', name: 'Ana', surname: 'Pop', city: 'Cluj', county: 'Cluj' }],
  farmers: [
    {
      id: '77',
      'farm name': 'Gradina Verde',
      'display name': 'Gradina',
      charges_enabled: true,
      stripe_account_id: 'acct_farm',
    },
  ],
  products: [{ id: 'p-1', 'product name': 'Rosii', quantity: 20, Price: 20, farmer_id: '77' }],
  checkouts: [
    {
      id: 'chk-1',
      client_id: '10',
      state: 'paid',
      transfer_group: 'chk_group_1',
      stripe_payment_intent_id: 'pi_1',
      total_bani: CHARGED_TO_CUSTOMER,
      ...checkout,
    },
  ],
  orders: [
    {
      id: 'ord-1',
      farmer_id: '77',
      client_id: '10',
      order_state: 'arrived',
      checkout_id: 'chk-1',
      total_price: 115,
      products_subtotal_bani: 10000,
      delivery_fee_bani: 1500,
      commission_bani: 1000,
      commission_bps: 1000,
      transfer_amount_bani: OWED_TO_FARMER,
      refunded_transfer_bani: 0,
      // The escrow state: paid for, held by the platform, nobody's yet.
      transfer_state: 'held',
      stripe_transfer_id: null,
      stripe_account_id: 'acct_farm',
      refunded_bani: 0,
      refund_state: 'none',
      paid_at: '2026-08-01T10:00:00.000Z',
      payout_hold_started_at: '2026-08-01T10:00:00.000Z',
      arrived_at: '2026-08-02T10:00:00.000Z',
      ...order,
    },
  ],
  order_items: [
    {
      id: 'item-1',
      order_id: 'ord-1',
      product_id: 'p-1',
      product_name: 'Rosii',
      product_unit: 'kg',
      quantity: 5,
      unit_price: 20,
      line_total: 100,
    },
  ],
  ...extra,
});

const buildEscrowApp = (options = {}) => {
  const stripe = options.stripe || createFakeStripe(options.stripeOptions);
  const { app, fake } = buildApp(options.seed || seed(), {
    stripe,
    rpc: orderRpc(options.rpc),
  });
  return { app, fake, stripe };
};

const orderRow = (fake, id = 'ord-1') => fake._db.orders.find((row) => row.id === id);

const setState = async ({ app, cookie, nextState, orderId = 'ord-1' }) =>
  request(app)
    .patch(`/api/orders/${orderId}/state`)
    .set(browserHeaders)
    .set('Cookie', cookie)
    .send({ nextState });

describe('escrow — the card clears but nothing reaches the farmer', () => {
  const paymentEvent = (id = 'evt_paid_1') => ({
    id,
    type: 'payment_intent.succeeded',
    data: { object: { id: 'pi_1', metadata: { checkout_id: 'chk-1' } } },
  });

  const postWebhook = async (app, event) => {
    const payload = JSON.stringify(event);
    const signature = signer.webhooks.generateTestHeaderString({
      payload,
      secret: WEBHOOK_SECRET,
    });
    return request(app)
      .post('/api/webhook/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', signature)
      .send(payload);
  };

  /**
   * The headline property. Before this change the same webhook fired a
   * Transfer; if this test ever goes red because `transfers` is non-empty,
   * the platform has silently gone back to paying farmers up front.
   */
  it('a paid checkout puts the money in escrow and calls no transfer', async () => {
    const { app, fake, stripe } = buildEscrowApp({
      seed: seed({
        order: { order_state: 'pending_order', transfer_state: 'none', arrived_at: null },
        checkout: { state: 'pending' },
      }),
    });
    // The real webhook needs the real signature verification.
    stripe.webhooks = signer.webhooks;

    const response = await postWebhook(app, paymentEvent());

    expect(response.status).toBe(200);

    const order = orderRow(fake);
    expect(order.order_state).toBe('received_by_farmer');
    expect(order.transfer_state).toBe('held');
    expect(order.payout_hold_started_at).toBeTruthy();

    // The money is on the platform balance, not the farmer's.
    expect(stripe._calls.transfers).toHaveLength(0);
    expect(fake._db.order_transfers || []).toHaveLength(0);
  });

  it('a redelivered payment event does not disturb an order already held', async () => {
    const { app, fake, stripe } = buildEscrowApp({
      seed: seed({
        order: { order_state: 'pending_order', transfer_state: 'none', arrived_at: null },
        checkout: { state: 'pending' },
      }),
    });
    stripe.webhooks = signer.webhooks;

    await postWebhook(app, paymentEvent('evt_paid_1'));
    const firstHoldStartedAt = orderRow(fake).payout_hold_started_at;

    // Stripe redelivers until it gets a 2xx; a different event id is a
    // genuinely new delivery of the same fact.
    const second = await postWebhook(app, paymentEvent('evt_paid_2'));

    expect(second.status).toBe(200);
    expect(orderRow(fake).transfer_state).toBe('held');
    expect(orderRow(fake).payout_hold_started_at).toBe(firstHoldStartedAt);
    expect(stripe._calls.transfers).toHaveLength(0);
  });
});

describe('escrow — confirming receipt is what pays the farmer', () => {
  it('the customer confirming releases exactly what is owed', async () => {
    const { app, fake, stripe } = buildEscrowApp();
    const cookie = await sessionCookieFor(CUSTOMER);

    const response = await setState({ app, cookie, nextState: 'received' });

    expect(response.status).toBe(200);
    expect(stripe._calls.transfers).toHaveLength(1);

    const [transfer] = stripe._calls.transfers;
    expect(transfer.params.amount).toBe(OWED_TO_FARMER);
    expect(transfer.params.currency).toBe('ron');
    expect(transfer.params.destination).toBe('acct_farm');
    expect(transfer.params.transfer_group).toBe('chk_group_1');
    // The commission never leaves the platform.
    expect(transfer.params.amount).toBeLessThan(CHARGED_TO_CUSTOMER);

    const order = orderRow(fake);
    expect(order.order_state).toBe('received');
    expect(order.transfer_state).toBe('sent');
    expect(order.stripe_transfer_id).toBe('tr_1');
    expect(order.payout_released_at).toBeTruthy();
  });

  it.each([
    ['received_by_farmer', 'preparing_order'],
    ['preparing_order', 'in_transit'],
    ['in_transit', 'arrived'],
  ])('moving %s -> %s pays nobody', async (from, to) => {
    const { app, fake, stripe } = buildEscrowApp({
      seed: seed({ order: { order_state: from, arrived_at: null } }),
    });
    const cookie = await sessionCookieFor(VENDOR);

    const response = await setState({ app, cookie, nextState: to });

    expect(response.status).toBe(200);
    expect(stripe._calls.transfers).toHaveLength(0);
    expect(orderRow(fake).transfer_state).toBe('held');
  });

  /**
   * The customer double-clicks, or the auto-confirm sweep lands on the same
   * order the customer is confirming. Both paths call `releaseOrderPayout`,
   * and `order_transfers.order_id` is unique, so only one of them can win.
   */
  it('two releases of the same order produce one transfer', async () => {
    const { fake, stripe } = buildEscrowApp({
      seed: seed({ order: { order_state: 'received' } }),
    });
    const { releaseOrderPayout } = require('../../src/lib/transfers');

    const [first, second] = await Promise.all([
      releaseOrderPayout({ orderId: 'ord-1' }),
      releaseOrderPayout({ orderId: 'ord-1' }),
    ]);

    expect(stripe._calls.transfers).toHaveLength(1);
    expect([first.released, second.released].filter(Boolean)).toHaveLength(1);
    expect(orderRow(fake).transfer_state).toBe('sent');

    // And a third attempt, long after, still finds it done.
    const third = await releaseOrderPayout({ orderId: 'ord-1' });
    expect(third.released).toBe(false);
    expect(third.reason).toBe('already_sent');
    expect(stripe._calls.transfers).toHaveLength(1);
  });

  it('the Stripe idempotency key is the order, so a retry cannot pay twice', async () => {
    const { stripe } = buildEscrowApp({ seed: seed({ order: { order_state: 'received' } }) });
    const { releaseOrderPayout } = require('../../src/lib/transfers');

    await releaseOrderPayout({ orderId: 'ord-1' });

    expect(stripe._calls.transfers[0].options.idempotencyKey).toBe('transfer-order-ord-1');
  });

  it('refuses to release an order that was never confirmed', async () => {
    const { stripe } = buildEscrowApp({
      seed: seed({ order: { order_state: 'in_transit' } }),
    });
    const { releaseOrderPayout } = require('../../src/lib/transfers');

    const result = await releaseOrderPayout({ orderId: 'ord-1' });

    expect(result.released).toBe(false);
    expect(result.reason).toBe('not_confirmed');
    expect(stripe._calls.transfers).toHaveLength(0);
  });

  it('refuses to release against a checkout that was never paid', async () => {
    const { stripe } = buildEscrowApp({
      seed: seed({ order: { order_state: 'received' }, checkout: { state: 'pending' } }),
    });
    const { releaseOrderPayout } = require('../../src/lib/transfers');

    const result = await releaseOrderPayout({ orderId: 'ord-1' });

    expect(result.released).toBe(false);
    expect(result.reason).toBe('checkout_not_paid');
    expect(stripe._calls.transfers).toHaveLength(0);
  });

  /**
   * An order can reach `received` with `transfer_state = 'none'` only if it
   * was never charged for. Paying out against it would be inventing money.
   */
  it('refuses to release an order that was never paid for', async () => {
    const { stripe } = buildEscrowApp({
      seed: seed({ order: { order_state: 'received', transfer_state: 'none' } }),
    });
    const { releaseOrderPayout } = require('../../src/lib/transfers');

    const result = await releaseOrderPayout({ orderId: 'ord-1' });

    expect(result.released).toBe(false);
    expect(result.reason).toBe('never_paid');
    expect(stripe._calls.transfers).toHaveLength(0);
  });

  it('records a payout it cannot send for want of a destination account', async () => {
    const { fake, stripe } = buildEscrowApp({
      seed: seed({ order: { order_state: 'received', stripe_account_id: null } }),
    });
    const { releaseOrderPayout } = require('../../src/lib/transfers');

    const result = await releaseOrderPayout({ orderId: 'ord-1' });

    expect(result.released).toBe(false);
    expect(stripe._calls.transfers).toHaveLength(0);
    // Visible in `/api/health/diagnostics`, not silently lost.
    expect(orderRow(fake).transfer_state).toBe('manual_required');
  });
});

describe('escrow — the money goes back when the order does not arrive', () => {
  /**
   * The whole point of holding. The farmer is never paid, so the refund is
   * one Stripe call against the customer's card and nothing has to be
   * recovered from anybody.
   */
  it('a farmer declining a held order refunds the customer in full', async () => {
    const { app, fake, stripe } = buildEscrowApp({
      seed: seed({ order: { order_state: 'received_by_farmer', arrived_at: null } }),
    });
    const cookie = await sessionCookieFor(VENDOR);

    const response = await setState({ app, cookie, nextState: 'cancelled' });

    expect(response.status).toBe(200);

    // Everything the customer paid, including the platform's own commission.
    expect(stripe._calls.refunds).toHaveLength(1);
    expect(stripe._calls.refunds[0].params.amount).toBe(CHARGED_TO_CUSTOMER);
    expect(stripe._calls.refunds[0].params.payment_intent).toBe('pi_1');

    // Nothing to reverse: the farmer never had it.
    expect(stripe._calls.reversals).toHaveLength(0);
    expect(stripe._calls.transfers).toHaveLength(0);

    const order = orderRow(fake);
    expect(order.order_state).toBe('cancelled');
    expect(order.refund_state).toBe('refunded');
    // The farmer's whole share was withheld, so the order is settled in the
    // customer's direction and can never release later.
    expect(order.refunded_transfer_bani).toBe(OWED_TO_FARMER);
    expect(order.transfer_state).toBe('reversed');
  });

  it('a cancelled order that is later marked received still pays nothing', async () => {
    const { app, stripe } = buildEscrowApp({
      seed: seed({ order: { order_state: 'received_by_farmer', arrived_at: null } }),
    });
    const cookie = await sessionCookieFor(VENDOR);
    await setState({ app, cookie, nextState: 'cancelled' });

    const { releaseOrderPayout } = require('../../src/lib/transfers');
    const result = await releaseOrderPayout({ orderId: 'ord-1' });

    expect(result.released).toBe(false);
    expect(stripe._calls.transfers).toHaveLength(0);
  });

  it('the stock goes back on the shelf when a held order is cancelled', async () => {
    const { app, fake } = buildEscrowApp({
      seed: seed({ order: { order_state: 'received_by_farmer', arrived_at: null } }),
    });
    const cookie = await sessionCookieFor(VENDOR);

    await setState({ app, cookie, nextState: 'cancelled' });

    expect(fake._db.products[0].quantity).toBe(25);
  });
});

describe('escrow — a partial refund during the hold nets out of the release', () => {
  /**
   * The arithmetic that would otherwise be paid twice.
   *
   * 40.00 lei of products go back to the customer while the money is still
   * held. Under the old model that was a transfer reversal against a farmer
   * who had already been paid. Now there is nothing to reverse, so the amount
   * has to be remembered — and the release has to be 115.00 minus 40.00, not
   * 115.00. Getting this wrong means the platform funds the refund itself.
   */
  it('the farmer receives the gross minus what the customer already got back', async () => {
    const { app, fake, stripe } = buildEscrowApp({
      seed: seed({ order: { order_state: 'arrived' } }),
    });

    const { loadOrderForRefund, issueRefund } = require('../../src/lib/refunds');
    const order = await loadOrderForRefund('ord-1');
    const refund = await issueRefund({
      order,
      reason: 'Two crates short',
      actorType: 'farmer',
      actorId: '77',
      refundProductsBani: 4000,
    });

    expect(refund.refunded).toBe(true);
    // Products back, delivery kept (something was still driven to the door),
    // plus the proportional share of the commission.
    expect(refund.breakdown.kind).toBe('partial');
    expect(refund.breakdown.reversalAmountBani).toBe(4000);
    expect(stripe._calls.reversals).toHaveLength(0);
    expect(orderRow(fake).refunded_transfer_bani).toBe(4000);

    const cookie = await sessionCookieFor(CUSTOMER);
    const response = await setState({ app, cookie, nextState: 'received' });

    expect(response.status).toBe(200);
    expect(stripe._calls.transfers).toHaveLength(1);
    expect(stripe._calls.transfers[0].params.amount).toBe(OWED_TO_FARMER - 4000);
  });

  it('two partial refunds cannot withhold more than the farmer was ever owed', async () => {
    const { fake } = buildEscrowApp({ seed: seed({ order: { order_state: 'arrived' } }) });
    const { withholdFarmerShare } = require('../../src/lib/refunds');

    await withholdFarmerShare({ orderId: 'ord-1', amountBani: 9000 });
    await withholdFarmerShare({ orderId: 'ord-1', amountBani: 9000 });

    // Clamped at the whole share — never more, which would make the release
    // a negative transfer.
    expect(orderRow(fake).refunded_transfer_bani).toBe(OWED_TO_FARMER);
    expect(orderRow(fake).transfer_state).toBe('reversed');
  });

  it('an order refunded down to nothing releases no transfer at all', async () => {
    const { fake, stripe } = buildEscrowApp({
      seed: seed({
        order: {
          order_state: 'received',
          refunded_transfer_bani: OWED_TO_FARMER,
        },
      }),
    });
    const { releaseOrderPayout } = require('../../src/lib/transfers');

    const result = await releaseOrderPayout({ orderId: 'ord-1' });

    expect(result.released).toBe(false);
    expect(result.reason).toBe('zero_amount');
    expect(stripe._calls.transfers).toHaveLength(0);
    expect(orderRow(fake).transfer_state).toBe('reversed');
  });
});

describe('escrow — a failed release is retried, not lost', () => {
  it('a Stripe failure leaves the order retryable and the money still held', async () => {
    const { fake, stripe } = buildEscrowApp({
      seed: seed({ order: { order_state: 'received' } }),
      stripeOptions: { failures: { transfer: 'balance_insufficient' } },
    });
    const { releaseOrderPayout } = require('../../src/lib/transfers');

    const result = await releaseOrderPayout({ orderId: 'ord-1' });

    expect(result.released).toBe(false);
    const order = orderRow(fake);
    expect(order.transfer_state).toBe('failed');
    expect(order.transfer_error).toContain('balance_insufficient');
    expect(order.payout_released_at).toBeFalsy();
  });

  it('the hourly sweep picks up a confirmed order whose payout failed', async () => {
    const { fake, stripe } = buildEscrowApp({
      seed: seed({
        order: {
          order_state: 'received',
          transfer_state: 'failed',
          transfer_error: 'balance_insufficient: earlier attempt',
        },
        extra: {
          // The claim from the failed attempt is still there; the retry has to
          // get past it rather than be blocked by its own bookkeeping.
          order_transfers: [
            {
              id: 'tr-row-1',
              order_id: 'ord-1',
              checkout_id: 'chk-1',
              destination_account_id: 'acct_farm',
              amount_bani: OWED_TO_FARMER,
              state: 'failed',
            },
          ],
        },
      }),
    });
    const { retryStalePayouts } = require('../../src/lib/transfers');

    const summary = await retryStalePayouts();

    expect(summary.attempted).toBe(1);
    expect(summary.sent).toBe(1);
    expect(stripe._calls.transfers).toHaveLength(1);
    expect(orderRow(fake).transfer_state).toBe('sent');
  });

  it('the sweep does not touch orders that were never confirmed', async () => {
    const { stripe } = buildEscrowApp({
      seed: seed({ order: { order_state: 'in_transit', transfer_state: 'held' } }),
    });
    const { retryStalePayouts } = require('../../src/lib/transfers');

    const summary = await retryStalePayouts();

    expect(summary.attempted).toBe(0);
    expect(stripe._calls.transfers).toHaveLength(0);
  });
});

describe('escrow — nothing is held forever', () => {
  const daysAgo = (days) => new Date(Date.now() - days * 86400000).toISOString();

  it('auto-confirming a forgotten delivery also releases the payout', async () => {
    const { fake, stripe } = buildEscrowApp({
      seed: seed({ order: { order_state: 'arrived', arrived_at: daysAgo(9) } }),
    });
    const { autoConfirmStaleArrivedOrders } = require('../../src/lib/orderMaintenance');

    const confirmed = await autoConfirmStaleArrivedOrders();

    expect(confirmed).toBe(1);
    expect(orderRow(fake).order_state).toBe('received');
    expect(stripe._calls.transfers).toHaveLength(1);
    expect(stripe._calls.transfers[0].params.amount).toBe(OWED_TO_FARMER);
    expect(orderRow(fake).transfer_state).toBe('sent');
  });

  /**
   * The other half of the promise. An order the farm accepted and then never
   * moved would otherwise hold the customer's money indefinitely: nobody
   * cancels it, so nothing refunds it, and it never reaches `arrived` so
   * auto-confirm never sees it.
   */
  it('an order that never arrived is cancelled and refunded', async () => {
    const { fake, stripe } = buildEscrowApp({
      seed: seed({
        order: {
          order_state: 'received_by_farmer',
          arrived_at: null,
          paid_at: daysAgo(20),
          payout_hold_started_at: daysAgo(20),
        },
      }),
    });
    const { expireUndeliveredOrders } = require('../../src/lib/orderMaintenance');

    const expired = await expireUndeliveredOrders();

    expect(expired).toBe(1);

    const order = orderRow(fake);
    expect(order.order_state).toBe('cancelled');
    expect(order.cancelled_by).toBe('system');
    expect(order.refund_state).toBe('refunded');

    expect(stripe._calls.refunds).toHaveLength(1);
    expect(stripe._calls.refunds[0].params.amount).toBe(CHARGED_TO_CUSTOMER);
    expect(stripe._calls.transfers).toHaveLength(0);
    // Stock is not left reserved against an order nobody will ever deliver.
    expect(fake._db.products[0].quantity).toBe(25);
  });

  it('leaves a recent order alone', async () => {
    const { fake, stripe } = buildEscrowApp({
      seed: seed({
        order: { order_state: 'received_by_farmer', arrived_at: null, paid_at: daysAgo(3) },
      }),
    });
    const { expireUndeliveredOrders } = require('../../src/lib/orderMaintenance');

    expect(await expireUndeliveredOrders()).toBe(0);
    expect(orderRow(fake).order_state).toBe('received_by_farmer');
    expect(stripe._calls.refunds).toHaveLength(0);
  });

  it('leaves an old order alone while a dispute is open on it', async () => {
    const { fake, stripe } = buildEscrowApp({
      seed: seed({
        order: { order_state: 'preparing_order', arrived_at: null, paid_at: daysAgo(20) },
        extra: {
          disputes: [{ id: 'disp-1', order_id: 'ord-1', state: 'awaiting_farmer' }],
        },
      }),
    });
    const { expireUndeliveredOrders } = require('../../src/lib/orderMaintenance');

    expect(await expireUndeliveredOrders()).toBe(0);
    expect(orderRow(fake).order_state).toBe('preparing_order');
    expect(stripe._calls.refunds).toHaveLength(0);
  });

  /**
   * An order from before escrow, or one an admin released by hand. Clawing it
   * back is a decision a person makes, not something a sweep does at 3am.
   */
  it('never expires an order whose payout has already gone out', async () => {
    const { fake, stripe } = buildEscrowApp({
      seed: seed({
        order: {
          order_state: 'in_transit',
          arrived_at: null,
          paid_at: daysAgo(30),
          transfer_state: 'sent',
          stripe_transfer_id: 'tr_old',
        },
      }),
    });
    const { expireUndeliveredOrders } = require('../../src/lib/orderMaintenance');

    expect(await expireUndeliveredOrders()).toBe(0);
    expect(orderRow(fake).order_state).toBe('in_transit');
    expect(stripe._calls.reversals).toHaveLength(0);
    expect(stripe._calls.refunds).toHaveLength(0);
  });
});

describe('escrow — the platform can always say what it is holding', () => {
  it('reports the held total and flags money stranded on a finished order', async () => {
    const { fake } = buildEscrowApp({
      seed: seed({
        order: { order_state: 'arrived' },
        extra: {},
      }),
    });
    // A second order, confirmed but never released: this is the one that
    // should raise an eyebrow.
    fake._db.orders.push({
      id: 'ord-2',
      farmer_id: '77',
      client_id: '10',
      checkout_id: 'chk-1',
      order_state: 'received',
      transfer_state: 'failed',
      transfer_amount_bani: 5000,
      refunded_transfer_bani: 0,
    });

    const { heldPayoutSummary } = require('../../src/lib/transfers');
    const summary = await heldPayoutSummary();

    expect(summary.heldOrders).toBe(2);
    expect(summary.heldBani).toBe(OWED_TO_FARMER + 5000);
    expect(summary.stuckOrders).toBe(1);
  });
});
