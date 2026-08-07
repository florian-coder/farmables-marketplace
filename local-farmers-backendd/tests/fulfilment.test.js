// OPS-06 + LOG-04 — what actually went in the box.
//
// Two audit findings that are one problem: "a farmer with 3 of 5 kg can only
// decline the whole order", and "customer terms §10.4 has a ±[10]% placeholder
// that matches no implementation".
//
// The rules these lock down, which are now identical in the terms and here:
//   within tolerance → the price stands, either way
//   short beyond it  → refunded automatically, without anyone complaining
//   over             → never charged for

const { evaluateFulfilment, DEFAULT_TOLERANCE_BPS } = require('../src/lib/fulfilment');
const {
  availabilityBlocker,
  parseAvailabilityInput,
  serializeAvailability,
} = require('../src/lib/availability');

/** 5 kg at 20.00 lei = 100.00 lei. */
const item = (overrides = {}) => ({
  id: 'item-1',
  product_name: 'Rosii',
  quantity: 5,
  unit_price: 20,
  line_total: 100,
  ...overrides,
});

describe('LOG-04 — the weight tolerance', () => {
  it('is the 10% the customer terms promise', () => {
    expect(DEFAULT_TOLERANCE_BPS).toBe(1000);
  });

  it('absorbs a small shortfall — a bag of tomatoes is never exactly a kilo', () => {
    // 4.6 of 5 kg is 8% short. Refunding that would cost more in Stripe fees
    // than it returns.
    const result = evaluateFulfilment({ items: [item()], fulfilled: { 'item-1': 4.6 } });

    expect(result.shortfallBani).toBe(0);
    expect(result.kind).toBe('full');
    expect(result.lines[0].withinTolerance).toBe(true);
  });

  it('refunds a shortfall past the tolerance, in full', () => {
    // 3 of 5 kg is 40% short — the exact case from the audit.
    const result = evaluateFulfilment({ items: [item()], fulfilled: { 'item-1': 3 } });

    expect(result.kind).toBe('partial');
    // 2 kg of a 100.00 lei line = 40.00 lei.
    expect(result.shortfallBani).toBe(4000);
    expect(result.lines[0].withinTolerance).toBe(false);
  });

  it('refunds from the tolerance boundary, not from zero', () => {
    // Once past the line, the whole shortfall comes back — not just the part
    // beyond 10%. The tolerance says "this much is not worth arguing about",
    // not "you get to keep the first 10% of anything you short".
    const result = evaluateFulfilment({ items: [item()], fulfilled: { 'item-1': 4 } });
    expect(result.shortfallBani).toBe(2000);
  });

  it('never charges for more than was ordered', () => {
    // The farm gave 6 kg for a 5 kg order. That is on them, and it evens out.
    const result = evaluateFulfilment({ items: [item()], fulfilled: { 'item-1': 6 } });

    expect(result.shortfallBani).toBe(0);
    expect(result.lines[0].over).toBe(true);
    expect(result.kind).toBe('full');
  });

  it('treats an unrecorded item as delivered in full', () => {
    // A farm that only corrects the two items it had to short should not have
    // to retype the other eight.
    const result = evaluateFulfilment({
      items: [item(), item({ id: 'item-2', product_name: 'Ceapa' })],
      fulfilled: { 'item-1': 3 },
    });

    expect(result.lines[1].deliveredQty).toBe(5);
    expect(result.shortfallBani).toBe(4000);
  });

  it('scales the tolerance with the size of the order', () => {
    // 10% of a 1 kg bag is 100 g; 10% of a 10 kg sack is a kilo. A scoop is a
    // scoop either way.
    const small = evaluateFulfilment({
      items: [item({ quantity: 1, line_total: 20 })],
      fulfilled: { 'item-1': 0.95 },
    });
    expect(small.shortfallBani).toBe(0);

    const large = evaluateFulfilment({
      items: [item({ quantity: 10, line_total: 200 })],
      fulfilled: { 'item-1': 9.5 },
    });
    expect(large.shortfallBani).toBe(0);
  });

  it('calls nothing delivered a non-delivery, not a partial one', () => {
    const result = evaluateFulfilment({ items: [item()], fulfilled: { 'item-1': 0 } });

    expect(result.kind).toBe('none_delivered');
    expect(result.shortfallBani).toBe(10000);
  });

  it('refuses a nonsense quantity rather than guessing', () => {
    expect(evaluateFulfilment({ items: [item()], fulfilled: { 'item-1': -1 } }).ok).toBe(false);
    expect(evaluateFulfilment({ items: [item()], fulfilled: { 'item-1': 'lots' } }).ok).toBe(false);
  });

  it('adds up across several short items', () => {
    const result = evaluateFulfilment({
      items: [item(), item({ id: 'item-2', product_name: 'Ceapa', quantity: 2, line_total: 30 })],
      fulfilled: { 'item-1': 3, 'item-2': 1 },
    });

    // 40.00 from the tomatoes + 15.00 from the onions.
    expect(result.shortfallBani).toBe(5500);
  });
});

describe('OPS-06 — when a farm is open', () => {
  const monday10am = new Date('2026-08-03T10:00:00.000Z'); // a Monday

  it('leaves a farm with nothing configured always open', () => {
    // Every farm that exists today. None of them should go dark because a
    // column appeared.
    expect(
      availabilityBlocker({ farmer: {}, farmName: 'Gradina', now: monday10am }),
    ).toBeNull();
  });

  it('flags a closed weekday as a delay, not a refusal', () => {
    const blocker = availabilityBlocker({
      farmer: { working_hours: { 2: { open: '08:00', close: '18:00' } } },
      farmName: 'Gradina',
      now: monday10am,
    });

    expect(blocker.code).toBe('farm_closed_weekday');
    // Advisory: refusing the order would just send the customer elsewhere.
    expect(blocker.advisory).toBe(true);
  });

  it('flags being outside opening hours the same way', () => {
    const blocker = availabilityBlocker({
      farmer: { working_hours: { 1: { open: '14:00', close: '18:00' } } },
      farmName: 'Gradina',
      now: monday10am,
    });

    expect(blocker.code).toBe('farm_closed_now');
    expect(blocker.advisory).toBe(true);
  });

  it('flags a holiday', () => {
    const blocker = availabilityBlocker({
      farmer: { closed_dates: ['2026-08-03'] },
      farmName: 'Gradina',
      now: monday10am,
    });

    expect(blocker.code).toBe('farm_closed_today');
    expect(blocker.advisory).toBe(true);
  });

  it('blocks — really blocks — a farm at capacity', () => {
    // A farm that said how many boxes it can pack said it in advance. Taking
    // one more is knowingly selling something that will not be delivered.
    const blocker = availabilityBlocker({
      farmer: { daily_order_capacity: 20 },
      farmName: 'Gradina',
      now: monday10am,
      ordersToday: 20,
    });

    expect(blocker.code).toBe('farm_at_capacity');
    expect(blocker.advisory).toBe(false);
  });

  it('lets an order through while there is still room', () => {
    expect(
      availabilityBlocker({
        farmer: { daily_order_capacity: 20 },
        farmName: 'Gradina',
        now: monday10am,
        ordersToday: 19,
      }),
    ).toBeNull();
  });

  it('treats a capacity of zero as no limit', () => {
    expect(
      availabilityBlocker({
        farmer: { daily_order_capacity: 0 },
        farmName: 'Gradina',
        now: monday10am,
        ordersToday: 9999,
      }),
    ).toBeNull();
  });
});

describe('OPS-06 — validating what a farmer submits', () => {
  it('accepts a sensible week', () => {
    const result = parseAvailabilityInput({
      workingHours: [
        { day: 1, open: '08:00', close: '18:00' },
        { day: 6, open: '09:00', close: '13:00' },
      ],
      closedDates: ['2026-12-25'],
      dailyOrderCapacity: 15,
    });

    expect(result.ok).toBe(true);
    expect(result.patch.working_hours['1'].open).toBe('08:00');
    expect(result.patch.daily_order_capacity).toBe(15);
  });

  it('refuses a closing time before the opening time', () => {
    const result = parseAvailabilityInput({
      workingHours: [{ day: 1, open: '18:00', close: '08:00' }],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/after opening/i);
  });

  it('refuses malformed times, days and dates', () => {
    expect(parseAvailabilityInput({ workingHours: [{ day: 9, open: '08:00', close: '18:00' }] }).ok).toBe(false);
    expect(parseAvailabilityInput({ workingHours: [{ day: 1, open: 'morning', close: '18:00' }] }).ok).toBe(false);
    expect(parseAvailabilityInput({ closedDates: ['christmas'] }).ok).toBe(false);
    expect(parseAvailabilityInput({ dailyOrderCapacity: -5 }).ok).toBe(false);
  });

  it('describes a farm with nothing set as always open', () => {
    expect(serializeAvailability({}).alwaysOpen).toBe(true);
    expect(serializeAvailability({ working_hours: { 1: { open: '08:00', close: '18:00' } } }).alwaysOpen).toBe(
      false,
    );
  });
});
