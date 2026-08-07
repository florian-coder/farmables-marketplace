// OPS-04 — orders that close themselves.
//
// The fairness property is the one worth testing: silence only counts as
// consent when the customer was warned what silence would mean, and an order
// with a refund in flight is an open case, not a forgotten one.

const path = require('path');

const { createFakeSupabase } = require('./helpers/fakeSupabase');

const BACKEND_ROOT = path.join(__dirname, '..');

const daysAgo = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

const loadMaintenance = (seed) => {
  jest.resetModules();
  const fake = createFakeSupabase(seed);
  const notified = [];

  jest.doMock(path.join(BACKEND_ROOT, 'src/lib/supabase.js'), () => {
    const actual = jest.requireActual(path.join(BACKEND_ROOT, 'src/lib/supabase.js'));
    return { ...actual, supabase: fake };
  });

  jest.doMock(path.join(BACKEND_ROOT, 'src/lib/notifications.js'), () => ({
    notifyAutoConfirmWarning: async (args) => {
      notified.push(args);
    },
  }));

  // eslint-disable-next-line global-require
  const maintenance = require(path.join(BACKEND_ROOT, 'src/lib/orderMaintenance.js'));
  return { maintenance, fake, notified };
};

const arrivedOrder = (overrides = {}) => ({
  id: 'ord-1',
  client_id: '10',
  farmer_id: '77',
  order_state: 'arrived',
  arrived_at: daysAgo(10),
  updated_at: daysAgo(10),
  refund_state: 'none',
  ...overrides,
});

describe('OPS-04 — warning before closing', () => {
  test('warns an order that has been at the door for days', async () => {
    const { maintenance, notified } = loadMaintenance({ orders: [arrivedOrder({ arrived_at: daysAgo(5) })] });

    const warned = await maintenance.warnStaleArrivedOrders();

    expect(warned).toBe(1);
    expect(notified[0].order.id).toBe('ord-1');
    expect(notified[0].daysLeft).toBeGreaterThan(0);
  });

  test('leaves a fresh arrival alone', async () => {
    const { maintenance, notified } = loadMaintenance({ orders: [arrivedOrder({ arrived_at: daysAgo(1) })] });

    expect(await maintenance.warnStaleArrivedOrders()).toBe(0);
    expect(notified).toHaveLength(0);
  });
});

describe('OPS-04 — closing', () => {
  test('confirms an order nobody confirmed, and says so in the audit log', async () => {
    const { maintenance, fake } = loadMaintenance({ orders: [arrivedOrder()], audit_log: [] });

    const confirmed = await maintenance.autoConfirmStaleArrivedOrders();

    expect(confirmed).toBe(1);
    const order = fake._db.orders[0];
    expect(order.order_state).toBe('received');
    // Kept apart from a customer confirmation: a dispute needs to tell "they
    // said yes" from "nobody said anything for a week".
    expect(order.auto_confirmed_at).toBeTruthy();

    const entry = fake._db.audit_log.find((row) => row.action === 'order.state_changed');
    expect(entry.actor_type).toBe('system');
    expect(entry.new_value).toContain('auto_after');
  });

  test('does not close an order that is still within the window', async () => {
    const { maintenance, fake } = loadMaintenance({ orders: [arrivedOrder({ arrived_at: daysAgo(3) })] });

    expect(await maintenance.autoConfirmStaleArrivedOrders()).toBe(0);
    expect(fake._db.orders[0].order_state).toBe('arrived');
  });

  test('never closes an order with a refund in flight', async () => {
    // That is an open case. Closing it would silently end the dispute window
    // on the one order where the customer is most likely to need it.
    const { maintenance, fake } = loadMaintenance({
      orders: [arrivedOrder({ refund_state: 'pending' })],
    });

    expect(await maintenance.autoConfirmStaleArrivedOrders()).toBe(0);
    expect(fake._db.orders[0].order_state).toBe('arrived');
  });

  test('only touches orders that are actually at the door', async () => {
    const { maintenance, fake } = loadMaintenance({
      orders: [
        arrivedOrder({ id: 'ord-transit', order_state: 'in_transit' }),
        arrivedOrder({ id: 'ord-cancelled', order_state: 'cancelled' }),
      ],
    });

    expect(await maintenance.autoConfirmStaleArrivedOrders()).toBe(0);
    expect(fake._db.orders.map((row) => row.order_state)).toEqual(['in_transit', 'cancelled']);
  });
});
