// LOG-06 — seasons, pre-orders and baskets that repeat.
//
// The rounding corner worth locking down: a season may wrap the year.
// November to February is 11 → 2, which is how a winter crop actually works,
// and a naive `start <= month <= end` gets it exactly backwards — it would
// hide the product for the four months it is actually available and show it
// for the eight it is not.

const {
  isMonthInSeason,
  seasonStatus,
  preorderBlocker,
  nextDeliveryDate,
  parseSubscriptionInput,
} = require('../src/lib/seasonality');

describe('LOG-06 — a season that wraps the year', () => {
  it('handles a normal summer window', () => {
    // June to September.
    expect(isMonthInSeason(7, 6, 9)).toBe(true);
    expect(isMonthInSeason(6, 6, 9)).toBe(true);
    expect(isMonthInSeason(9, 6, 9)).toBe(true);
    expect(isMonthInSeason(5, 6, 9)).toBe(false);
    expect(isMonthInSeason(10, 6, 9)).toBe(false);
  });

  it('handles a winter window that crosses January', () => {
    // November to February. The case a naive comparison inverts.
    expect(isMonthInSeason(11, 11, 2)).toBe(true);
    expect(isMonthInSeason(12, 11, 2)).toBe(true);
    expect(isMonthInSeason(1, 11, 2)).toBe(true);
    expect(isMonthInSeason(2, 11, 2)).toBe(true);
    expect(isMonthInSeason(6, 11, 2)).toBe(false);
    expect(isMonthInSeason(10, 11, 2)).toBe(false);
  });

  it('treats a product with no window as available all year', () => {
    // Every product on the site today.
    expect(isMonthInSeason(3, null, null)).toBe(true);
    expect(isMonthInSeason(3, 5, null)).toBe(true);
  });
});

describe('LOG-06 — what the customer is told', () => {
  const july = new Date('2026-07-15T00:00:00.000Z');

  it('says when something is back rather than that it is gone', () => {
    // "Back in season in October" keeps the customer. "Out of stock" loses
    // them, and they do not come back to find out.
    const status = seasonStatus(
      { season_start_month: 10, season_end_month: 12 },
      july,
    );

    expect(status.inSeason).toBe(false);
    expect(status.label).toMatch(/Back in season in October/);
  });

  it('offers the pre-order when the farm has opened one', () => {
    const status = seasonStatus(
      {
        season_start_month: 10,
        season_end_month: 12,
        preorder_enabled: true,
        preorder_available_from: '2026-10-01',
        preorder_capacity: 100,
        preorder_committed: 20,
      },
      july,
    );

    expect(status.canPreorder).toBe(true);
    expect(status.label).toMatch(/Pre-order now/);
  });

  it('does not offer a pre-order that is already full', () => {
    const status = seasonStatus(
      {
        season_start_month: 10,
        season_end_month: 12,
        preorder_enabled: true,
        preorder_available_from: '2026-10-01',
        preorder_capacity: 100,
        preorder_committed: 100,
      },
      july,
    );

    expect(status.canPreorder).toBe(false);
  });

  it('stays quiet for something in season', () => {
    const status = seasonStatus({ season_start_month: 6, season_end_month: 9 }, july);
    expect(status.inSeason).toBe(true);
    expect(status.label).toMatch(/In season/);
  });
});

describe('LOG-06 — pre-order capacity', () => {
  const product = {
    preorder_enabled: true,
    preorder_available_from: '2026-10-01',
    preorder_capacity: 100,
    preorder_committed: 90,
  };

  it('allows what fits', () => {
    expect(preorderBlocker(product, 10)).toBeNull();
  });

  it('refuses more than the farm has promised, and says how much is left', () => {
    // Capacity is separate from stock because a pre-order does not consume
    // stock — without its own ceiling a farm can promise a field it has not
    // planted.
    const blocker = preorderBlocker(product, 20);
    expect(blocker.code).toBe('preorder_full');
    expect(blocker.message).toMatch(/Only 10 left/);
  });

  it('refuses a pre-order with no delivery date', () => {
    // OUG 34/2014 art. 19 requires a delivery date. "Sometime" is not one.
    const blocker = preorderBlocker({ ...product, preorder_available_from: null }, 1);
    expect(blocker.code).toBe('no_delivery_date');
  });

  it('refuses when pre-orders are off entirely', () => {
    expect(preorderBlocker({ preorder_enabled: false }, 1).code).toBe('preorder_disabled');
  });
});

describe('LOG-06 — the delivery schedule', () => {
  it('picks the next occurrence of the chosen weekday', () => {
    // Wednesday 2026-08-05 → next Saturday is the 8th.
    const { date } = nextDeliveryDate({
      from: new Date('2026-08-05T00:00:00.000Z'),
      weekday: 6,
    });
    expect(date.toISOString().slice(0, 10)).toBe('2026-08-08');
  });

  it('never schedules for today', () => {
    // A basket generated on the morning of delivery is a basket nobody packed.
    const { date } = nextDeliveryDate({
      from: new Date('2026-08-08T00:00:00.000Z'), // a Saturday
      weekday: 6,
    });
    expect(date.toISOString().slice(0, 10)).toBe('2026-08-15');
  });

  it('carries the interval for the frequency', () => {
    expect(nextDeliveryDate({ frequency: 'weekly' }).intervalDays).toBe(7);
    expect(nextDeliveryDate({ frequency: 'fortnightly' }).intervalDays).toBe(14);
    expect(nextDeliveryDate({ frequency: 'monthly' }).intervalDays).toBe(28);
  });
});

describe('LOG-06 — validating a basket', () => {
  const valid = {
    frequency: 'weekly',
    deliveryWeekday: 6,
    items: [{ productId: 'p-1', quantity: 2 }],
  };

  it('accepts a sensible basket', () => {
    const result = parseSubscriptionInput(valid);
    expect(result.ok).toBe(true);
    expect(result.value.items).toEqual([{ productId: 'p-1', quantity: 2 }]);
  });

  it('refuses an empty basket', () => {
    expect(parseSubscriptionInput({ ...valid, items: [] }).ok).toBe(false);
  });

  it('refuses an unknown frequency or weekday', () => {
    expect(parseSubscriptionInput({ ...valid, frequency: 'daily' }).ok).toBe(false);
    expect(parseSubscriptionInput({ ...valid, deliveryWeekday: 9 }).ok).toBe(false);
  });

  it('refuses an item with no quantity', () => {
    expect(parseSubscriptionInput({ ...valid, items: [{ productId: 'p-1' }] }).ok).toBe(false);
    expect(parseSubscriptionInput({ ...valid, items: [{ quantity: 2 }] }).ok).toBe(false);
  });

  it('accepts a run length, or none at all', () => {
    expect(parseSubscriptionInput({ ...valid, maxDeliveries: 12 }).ok).toBe(true);
    expect(parseSubscriptionInput({ ...valid, maxDeliveries: null }).ok).toBe(true);
    expect(parseSubscriptionInput({ ...valid, maxDeliveries: 0 }).ok).toBe(false);
  });
});
