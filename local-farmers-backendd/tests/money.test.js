// BIZ-01 — the commission arithmetic.
//
// The rule that matters: commission is rounded per farmer group and only then
// summed. If we ever rounded the aggregate instead, the amount charged to the
// card would stop matching the sum of the transfers plus our fee, and the
// difference would come quietly out of the platform balance.

const {
  leiToBani,
  baniToLei,
  formatBani,
  commissionBani,
  deliveryFeeBani,
  groupTotals,
  sumGroups,
  assertTotalsBalance,
} = require('../src/lib/money');

const BPS = 1000; // 10%

describe('leiToBani', () => {
  it('converts without float drift', () => {
    expect(leiToBani(12.34)).toBe(1234);
    expect(leiToBani('7.05')).toBe(705);
    expect(leiToBani(0.1 + 0.2)).toBe(30);
    // 1.005 is really 1.00499999999999989 in IEEE 754, so it rounds down.
    // Documented rather than fought: it is exactly why nothing downstream of
    // this boundary is allowed to be a float.
    expect(leiToBani(1.005)).toBe(100);
    // 0.125 is exactly representable, so it shows the intended half-up rule.
    expect(leiToBani(0.125)).toBe(13);
    expect(leiToBani(-0.125)).toBe(-13);
  });

  it('treats anything unparseable as zero rather than NaN', () => {
    expect(leiToBani(undefined)).toBe(0);
    expect(leiToBani('abc')).toBe(0);
  });

  it('round-trips through baniToLei', () => {
    for (const lei of [0, 1, 9.99, 123.45, 1000.5]) {
      expect(baniToLei(leiToBani(lei))).toBeCloseTo(lei, 2);
    }
  });
});

describe('commissionBani', () => {
  it('takes 10% of the product subtotal', () => {
    expect(commissionBani(10000, BPS)).toBe(1000);
    expect(commissionBani(5000, BPS)).toBe(500);
  });

  it('rounds half-up on the ban', () => {
    // 5 bani of commission owed on 0.55 lei — .5 rounds up, not to even.
    expect(commissionBani(55, BPS)).toBe(6);
    expect(commissionBani(45, BPS)).toBe(5);
    expect(commissionBani(15, BPS)).toBe(2);
    expect(commissionBani(25, BPS)).toBe(3);
  });

  it('never returns a fraction of a ban', () => {
    for (let subtotal = 0; subtotal <= 2000; subtotal += 7) {
      expect(Number.isInteger(commissionBani(subtotal, BPS))).toBe(true);
    }
  });

  it('honours a rate other than 10%', () => {
    expect(commissionBani(10000, 500)).toBe(500);
    expect(commissionBani(10000, 0)).toBe(0);
    expect(commissionBani(10000, 1250)).toBe(1250);
  });
});

describe('deliveryFeeBani', () => {
  it('charges the farmer fee by default', () => {
    expect(deliveryFeeBani({ feeBani: 1500, freeThresholdBani: null, productsSubtotalBani: 3000 })).toBe(1500);
  });

  it('waives the fee at or above the free-delivery threshold', () => {
    expect(deliveryFeeBani({ feeBani: 1500, freeThresholdBani: 10000, productsSubtotalBani: 10000 })).toBe(0);
    expect(deliveryFeeBani({ feeBani: 1500, freeThresholdBani: 10000, productsSubtotalBani: 9999 })).toBe(1500);
  });

  it('treats a zero or missing threshold as "no free delivery"', () => {
    expect(deliveryFeeBani({ feeBani: 1500, freeThresholdBani: 0, productsSubtotalBani: 999999 })).toBe(1500);
    expect(deliveryFeeBani({ feeBani: 1500, productsSubtotalBani: 999999 })).toBe(1500);
  });
});

describe('groupTotals', () => {
  it('applies commission to products only, never to delivery', () => {
    const totals = groupTotals({
      productsSubtotalBani: 10000,
      deliveryFeeBani: 1500,
      commissionBps: BPS,
    });

    expect(totals.commissionBani).toBe(1000); // 10% of 100 lei, not of 115
    expect(totals.transferAmountBani).toBe(11500); // farmer gets products + delivery
    expect(totals.customerTotalBani).toBe(12500);
  });

  it('gives the farmer the delivery fee in full', () => {
    const totals = groupTotals({
      productsSubtotalBani: 4321,
      deliveryFeeBani: 999,
      commissionBps: BPS,
    });
    expect(totals.transferAmountBani).toBe(4321 + 999);
  });
});

describe('sumGroups + assertTotalsBalance', () => {
  const build = (subtotals, fees) =>
    subtotals.map((subtotal, index) =>
      groupTotals({
        productsSubtotalBani: subtotal,
        deliveryFeeBani: fees[index] ?? 0,
        commissionBps: BPS,
      }),
    );

  it('balances for a single farmer', () => {
    const totals = sumGroups(build([10000], [1500]));
    expect(() => assertTotalsBalance(totals)).not.toThrow();
    expect(totals.customerTotalBani).toBe(12500);
  });

  it('balances for a three-farm cart with rounding on every group', () => {
    // Each subtotal rounds its commission a different way.
    const groups = build([55, 45, 1234], [500, 0, 750]);
    const totals = sumGroups(groups);

    expect(() => assertTotalsBalance(totals)).not.toThrow();
    // 5.5 → 6 (half up), 4.5 → 5 (half up), 123.4 → 123 (down).
    expect(totals.commissionBani).toBe(6 + 5 + 123);
    expect(totals.customerTotalBani).toBe(
      55 + 45 + 1234 + 500 + 0 + 750 + totals.commissionBani,
    );
  });

  it('keeps the sum of rounded commissions, not the commission of the sum', () => {
    // Three groups of 0.55 lei: rounded per group that is 3 × 6 = 18 bani.
    // Rounded on the aggregate (165 bani) it would be 17 — a ban we would
    // have charged nobody and owed ourselves.
    const groups = build([55, 55, 55], [0, 0, 0]);
    const totals = sumGroups(groups);

    expect(totals.commissionBani).toBe(18);
    expect(commissionBani(165, BPS)).toBe(17);
    expect(() => assertTotalsBalance(totals)).not.toThrow();
  });

  it('balances across a wide sweep of random carts', () => {
    for (let run = 0; run < 500; run += 1) {
      const farmCount = 1 + (run % 4);
      const subtotals = [];
      const fees = [];
      for (let farm = 0; farm < farmCount; farm += 1) {
        subtotals.push(((run * 37 + farm * 911) % 250000) + 1);
        fees.push(((run * 13 + farm * 7) % 2000));
      }

      const totals = sumGroups(build(subtotals, fees));
      expect(() => assertTotalsBalance(totals)).not.toThrow();
      // The invariant restated independently of the helper.
      expect(totals.customerTotalBani).toBe(totals.transferAmountBani + totals.commissionBani);
    }
  });

  it('throws when the totals are tampered with', () => {
    const totals = sumGroups(build([10000], [1500]));
    totals.customerTotalBani += 1;
    expect(() => assertTotalsBalance(totals)).toThrow(/invariant/i);
  });
});

describe('formatBani', () => {
  it('formats Romanian money for emails and error messages', () => {
    expect(formatBani(1234)).toBe('12,34 lei');
    expect(formatBani(0)).toBe('0,00 lei');
    expect(formatBani(100)).toBe('1,00 lei');
  });
});
