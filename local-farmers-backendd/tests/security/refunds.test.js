// OPS-01b — refunds.
//
// The finding these cover: "a customer whose paid order is declined by the
// farmer gets no money back", and "stock is not restored on cancellation".
// Both are properties of the whole route, not of one helper, so the tests go
// through the real router, the real state machine and the real refund module,
// with only Supabase and Stripe replaced.

const request = require('supertest');

const { buildApp, browserHeaders, sessionCookieFor } = require('../helpers/appHarness');
const { createFakeStripe } = require('../helpers/fakeStripe');
const { orderRpc } = require('../helpers/fakeRpc');

const CUSTOMER = { id: '10', role: 'customer', tokenVersion: 0 };
const VENDOR = { id: '77', role: 'vendor', tokenVersion: 0 };

/**
 * A paid, single-farm order worth 125.00 lei to the customer:
 * 100.00 products + 15.00 delivery + 10.00 commission. The farmer already has
 * 115.00 of it, which is what makes the reversal necessary.
 */
const seed = (overrides = {}) => ({
  users: [
    { id: '10', username: 'ana', email: 'ana@example.com', user_type: 'client', token_version: 0 },
    { id: '77', username: 'ferma', email: 'ferma@example.com', user_type: 'farmer', token_version: 0 },
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
  checkouts: [
    {
      id: 'chk-1',
      client_id: '10',
      state: 'paid',
      transfer_group: 'chk_group_1',
      stripe_payment_intent_id: 'pi_1',
      total_bani: 12500,
    },
  ],
  orders: [
    {
      id: 'ord-1',
      farmer_id: '77',
      client_id: '10',
      order_state: 'received_by_farmer',
      checkout_id: 'chk-1',
      total_price: 115,
      products_subtotal_bani: 10000,
      delivery_fee_bani: 1500,
      commission_bani: 1000,
      commission_bps: 1000,
      transfer_amount_bani: 11500,
      transfer_state: 'sent',
      stripe_transfer_id: 'tr_1',
      stripe_account_id: 'acct_farm',
      refunded_bani: 0,
      refund_state: 'none',
      paid_at: '2026-08-01T10:00:00.000Z',
      ...overrides.order,
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
  products: [
    {
      id: 'p-1',
      farmer_id: '77',
      'product name': 'Rosii',
      Unit: 'kg',
      Price: 20,
      // 5 kg were taken out of stock when the checkout reserved them.
      quantity: 3,
      available: true,
      instant_buy: true,
    },
  ],
  order_replies: [],
  refunds: [],
  audit_log: [],
  ...overrides.tables,
});

const decline = async (app, cookie, body = {}) =>
  request(app)
    .patch('/api/orders/ord-1/state')
    .set(browserHeaders)
    .set('Cookie', cookie)
    .send({ nextState: 'cancelled', ...body });

describe('OPS-01b — a farmer declining a paid order', () => {
  test('reverses the transfer, refunds the customer and puts the stock back', async () => {
    const stripe = createFakeStripe();
    const { app, fake } = buildApp(seed(), { rpc: orderRpc(), stripe });
    const cookie = await sessionCookieFor(VENDOR);

    const response = await decline(app, cookie, { reason: 'Hail damage' });

    expect(response.status).toBe(200);
    expect(response.body.order.orderState).toBe('cancelled');

    // 1. The farmer's share came back first — products + delivery, never the
    //    commission, which was ours to give up.
    expect(stripe._calls.reversals).toHaveLength(1);
    expect(stripe._calls.reversals[0].transferId).toBe('tr_1');
    expect(stripe._calls.reversals[0].params.amount).toBe(11500);

    // 2. Only then was the customer refunded — the full 125.00.
    expect(stripe._calls.refunds).toHaveLength(1);
    expect(stripe._calls.refunds[0].params.payment_intent).toBe('pi_1');
    expect(stripe._calls.refunds[0].params.amount).toBe(12500);

    // 3. The 5 kg went back on the shelf: 3 + 5 = 8.
    expect(fake._db.products[0].quantity).toBe(8);

    // 4. The ledger row records what happened, with the Stripe ids.
    const refund = fake._db.refunds[0];
    expect(refund.kind).toBe('full');
    expect(refund.amount_bani).toBe(12500);
    expect(refund.reversal_amount_bani).toBe(11500);
    expect(refund.state).toBe('completed');
    expect(refund.stripe_refund_id).toBeTruthy();
    expect(refund.stripe_transfer_reversal_id).toBeTruthy();

    // 5. The order carries the outcome without needing a join.
    expect(fake._db.orders[0].refund_state).toBe('refunded');
    expect(fake._db.orders[0].refunded_bani).toBe(12500);
  });

  test('the reversal happens before the refund, never the other way round', async () => {
    // Refunding first would push the platform balance negative and Stripe
    // would start declining unrelated transfers for other farmers.
    const order = [];
    const stripe = createFakeStripe();
    const wrappedStripe = {
      ...stripe,
      transfers: {
        ...stripe.transfers,
        createReversal: async (...args) => {
          order.push('reversal');
          return stripe.transfers.createReversal(...args);
        },
      },
      refunds: {
        create: async (...args) => {
          order.push('refund');
          return stripe.refunds.create(...args);
        },
      },
    };

    const { app } = buildApp(seed(), { rpc: orderRpc(), stripe: wrappedStripe });
    await decline(app, await sessionCookieFor(VENDOR));

    expect(order).toEqual(['reversal', 'refund']);
  });

  test('writes the cancellation and the refund to the audit log', async () => {
    // SEC-11 — `recordAudit` appeared zero times in orders.js before this.
    const { app, fake } = buildApp(seed(), { rpc: orderRpc(), stripe: createFakeStripe() });
    await decline(app, await sessionCookieFor(VENDOR), { reason: 'Out of stock' });

    const actions = fake._db.audit_log.map((entry) => entry.action);
    expect(actions).toContain('order.cancelled');
    expect(actions).toContain('refund.initiated');
    expect(actions).toContain('transfer.reversed');
    expect(actions).toContain('refund.completed');

    const cancellation = fake._db.audit_log.find((entry) => entry.action === 'order.cancelled');
    expect(cancellation.actor_type).toBe('farmer');
    expect(cancellation.actor_id).toBe('77');
    expect(cancellation.entity_id).toBe('ord-1');
  });
});

describe('OPS-01b — idempotency', () => {
  test('a second cancellation does not refund twice', async () => {
    const stripe = createFakeStripe();
    const { app, fake } = buildApp(seed(), { rpc: orderRpc(), stripe });
    const cookie = await sessionCookieFor(VENDOR);

    const first = await decline(app, cookie);
    expect(first.status).toBe(200);

    // The order is cancelled now, so the state machine refuses outright —
    // and says so in the most specific way it can rather than falling through
    // to the generic "this order is finished".
    const second = await decline(app, cookie);
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('already_in_state');

    expect(stripe._calls.refunds).toHaveLength(1);
    expect(fake._db.refunds).toHaveLength(1);
    // And the stock was restored once, not twice.
    expect(fake._db.products[0].quantity).toBe(8);
  });

  test('the refunds row is the claim: a duplicate insert stops the second run', async () => {
    const stripe = createFakeStripe();
    const { app, fake } = buildApp(
      seed({ tables: { refunds: [{ id: 'ref-existing', order_id: 'ord-1', kind: 'full', state: 'completed', amount_bani: 12500 }] } }),
      { rpc: orderRpc(), stripe },
    );

    const response = await decline(app, await sessionCookieFor(VENDOR));

    expect(response.status).toBe(200);
    expect(response.body.refund.reason).toBe('already_claimed');
    // No second call to Stripe, and no second ledger row.
    expect(stripe._calls.refunds).toHaveLength(0);
    expect(fake._db.refunds).toHaveLength(1);
  });

  test('every Stripe call carries an idempotency key derived from the refund', async () => {
    const stripe = createFakeStripe();
    const { app, fake } = buildApp(seed(), { rpc: orderRpc(), stripe });
    await decline(app, await sessionCookieFor(VENDOR));

    const refundId = fake._db.refunds[0].id;
    expect(stripe._calls.reversals[0].options.idempotencyKey).toBe(`reversal-refund-${refundId}`);
    expect(stripe._calls.refunds[0].options.idempotencyKey).toBe(`refund-${refundId}`);
  });
});

describe('OPS-01b — the farmer already withdrew the money', () => {
  test('the customer is still refunded, and the gap is flagged for recovery', async () => {
    // The customer's right to their money does not depend on whether we can
    // reach the farmer's balance. The platform carries the gap and someone
    // chases the farmer.
    const stripe = createFakeStripe({ failures: { reversal: 'balance_insufficient' } });
    const { app, fake } = buildApp(seed(), { rpc: orderRpc(), stripe });

    const response = await decline(app, await sessionCookieFor(VENDOR));

    expect(response.status).toBe(200);
    expect(response.body.refund.refunded).toBe(true);
    expect(response.body.refund.manualRecoveryNeeded).toBe(true);

    expect(stripe._calls.refunds).toHaveLength(1);
    expect(stripe._calls.refunds[0].params.amount).toBe(12500);

    expect(fake._db.refunds[0].state).toBe('refund_pending_manual');
    expect(fake._db.orders[0].refund_state).toBe('refund_pending_manual');

    const actions = fake._db.audit_log.map((entry) => entry.action);
    expect(actions).toContain('refund.manual_required');
  });

  test('a reversal failure we do not understand stops before touching the card', async () => {
    const stripe = createFakeStripe({ failures: { reversal: 'transfer_already_reversed' } });
    const { app, fake } = buildApp(seed(), { rpc: orderRpc(), stripe });

    const response = await decline(app, await sessionCookieFor(VENDOR));

    expect(response.status).toBe(200);
    expect(response.body.refund.refunded).toBe(false);
    expect(response.body.refund.reason).toBe('reversal_failed');
    // Nothing was refunded, so the platform is not silently short.
    expect(stripe._calls.refunds).toHaveLength(0);
    expect(fake._db.refunds[0].state).toBe('failed');
    expect(fake._db.orders[0].refund_state).toBe('failed');
  });
});

describe('OPS-01b — cancellations that owe nothing', () => {
  test('an unpaid order releases stock without calling Stripe', async () => {
    const stripe = createFakeStripe();
    const { app, fake } = buildApp(
      seed({ order: { order_state: 'pending_order', transfer_state: 'none', stripe_transfer_id: null, paid_at: null } }),
      { rpc: orderRpc(), stripe },
    );

    const response = await decline(app, await sessionCookieFor(CUSTOMER));

    expect(response.status).toBe(200);
    expect(fake._db.orders[0].order_state).toBe('cancelled');
    // Stock reserved by `process_checkout` goes back.
    expect(fake._db.products[0].quantity).toBe(8);
    // Nothing was charged, so nothing is refunded.
    expect(stripe._calls.refunds).toHaveLength(0);
    expect(stripe._calls.reversals).toHaveLength(0);
    expect(fake._db.refunds).toHaveLength(0);
  });

  test('a paid order whose transfer never left only refunds the customer', async () => {
    const stripe = createFakeStripe();
    const { app, fake } = buildApp(
      seed({ order: { transfer_state: 'pending', stripe_transfer_id: null } }),
      { rpc: orderRpc(), stripe },
    );

    const response = await decline(app, await sessionCookieFor(VENDOR));

    expect(response.status).toBe(200);
    expect(stripe._calls.reversals).toHaveLength(0);
    expect(stripe._calls.refunds).toHaveLength(1);
    expect(fake._db.refunds[0].state).toBe('completed');
  });

  test('emptying a cart deletes the row and touches neither stock nor Stripe', async () => {
    const stripe = createFakeStripe();
    const { app, fake } = buildApp(
      seed({ order: { order_state: 'placed_order', checkout_id: null, transfer_state: 'none', stripe_transfer_id: null, paid_at: null, products_subtotal_bani: 0, delivery_fee_bani: 0, commission_bani: 0, transfer_amount_bani: 0 } }),
      { rpc: orderRpc(), stripe },
    );

    const response = await decline(app, await sessionCookieFor(CUSTOMER));

    expect(response.status).toBe(200);
    expect(response.body.order.deleted).toBe(true);
    expect(fake._db.orders).toHaveLength(0);
    // A cart never reserved stock, so nothing is handed back.
    expect(fake._db.products[0].quantity).toBe(3);
    expect(stripe._calls.refunds).toHaveLength(0);
  });
});

describe('OPS-01b — the state machine guards the route', () => {
  test('an impossible transition is 409 with a code the client can branch on', async () => {
    const { app } = buildApp(seed(), { rpc: orderRpc(), stripe: createFakeStripe() });

    const response = await request(app)
      .patch('/api/orders/ord-1/state')
      .set(browserHeaders)
      .set('Cookie', await sessionCookieFor(VENDOR))
      .send({ nextState: 'received' });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('invalid_transition');
  });

  test('a state that is not an order state at all is still 400', async () => {
    const { app } = buildApp(seed(), { rpc: orderRpc(), stripe: createFakeStripe() });

    const response = await request(app)
      .patch('/api/orders/ord-1/state')
      .set(browserHeaders)
      .set('Cookie', await sessionCookieFor(VENDOR))
      .send({ nextState: 'shipped_by_owl' });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('unknown_state');
  });

  test('a customer cannot drive the farmer half of the flow', async () => {
    const { app } = buildApp(
      seed({ order: { order_state: 'preparing_order' } }),
      { rpc: orderRpc(), stripe: createFakeStripe() },
    );

    const response = await request(app)
      .patch('/api/orders/ord-1/state')
      .set(browserHeaders)
      .set('Cookie', await sessionCookieFor(CUSTOMER))
      .send({ nextState: 'in_transit' });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('actor_not_allowed');
  });

  test('another customer cannot cancel an order that is not theirs', async () => {
    // A real, signed-in account — otherwise this would only prove that an
    // unknown user id fails authentication, which is a different check.
    const base = seed();
    base.users.push({
      id: '999',
      username: 'strain',
      email: 'strain@example.com',
      user_type: 'client',
      token_version: 0,
    });
    const { app, fake } = buildApp(base, { rpc: orderRpc(), stripe: createFakeStripe() });

    const response = await request(app)
      .patch('/api/orders/ord-1/state')
      .set(browserHeaders)
      .set('Cookie', await sessionCookieFor({ id: '999', role: 'customer', tokenVersion: 0 }))
      .send({ nextState: 'cancelled' });

    expect(response.status).toBe(403);
    expect(fake._db.orders[0].order_state).toBe('received_by_farmer');
  });
});
