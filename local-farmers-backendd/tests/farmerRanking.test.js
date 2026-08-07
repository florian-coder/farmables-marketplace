// LEG-05 — farmer of the month.
//
// The categories are the ones the site actually sells. Before this they were
// `meat` / `fruits_and_vegetables` / `dairy_products`, so two of the three
// awards were permanently unwinnable — "farmer of the month for Dairy" was
// always nobody, on a site that has never sold dairy.

const {
  CATEGORY_CONFIG,
  SCORE_WEIGHTS,
  buildMonthlyWinners,
  normalizeCategory,
} = require('../src/lib/farmerRanking');

describe('the categories match what is for sale', () => {
  it('is exactly fruit & veg, eggs and honey', () => {
    expect(CATEGORY_CONFIG.map((entry) => entry.key)).toEqual([
      'fruits_and_vegetables',
      'eggs',
      'honey',
    ]);
  });

  it('normalizes the spellings the database actually contains', () => {
    expect(normalizeCategory('Fruit & Veg')).toBe('fruits_and_vegetables');
    expect(normalizeCategory('fruits_and_veggies')).toBe('fruits_and_vegetables');
    expect(normalizeCategory('Vegetables')).toBe('fruits_and_vegetables');
    expect(normalizeCategory('Eggs')).toBe('eggs');
    expect(normalizeCategory('honey')).toBe('honey');
    // Romanian names appear in older rows.
    expect(normalizeCategory('oua')).toBe('eggs');
    expect(normalizeCategory('miere')).toBe('honey');
  });

  it('ignores categories that are not sold here', () => {
    expect(normalizeCategory('meat')).toBeNull();
    expect(normalizeCategory('dairy')).toBeNull();
    expect(normalizeCategory('')).toBeNull();
    expect(normalizeCategory(null)).toBeNull();
  });
});

describe('the weighted score', () => {
  it('is published and adds up to one', () => {
    // LEG-05 requires the ranking parameters to be explained publicly, so the
    // weights have to be a fact of the code, not a comment in it.
    expect(SCORE_WEIGHTS).toEqual({ revenue: 0.5, orders: 0.3, quantity: 0.2 });
    const total = Object.values(SCORE_WEIGHTS).reduce((sum, value) => sum + value, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it('selects the winner on the weighted, normalized coefficient', () => {
    const result = buildMonthlyWinners([
      {
        category: 'fruits_and_vegetables',
        farmerId: 'farmer-a',
        farmerName: 'Farmer A',
        farmName: 'Alpha Farm',
        revenue: 1000,
        orderCount: 20,
        quantity: 200,
      },
      {
        category: 'fruits_and_vegetables',
        farmerId: 'farmer-b',
        farmerName: 'Farmer B',
        farmName: 'Beta Farm',
        // More orders and more kilos, but less money — and money is half the
        // score, so A still wins.
        revenue: 800,
        orderCount: 25,
        quantity: 210,
      },
    ]);

    const produce = result.categories.find(
      (entry) => entry.category === 'fruits_and_vegetables',
    );
    expect(produce.winner.farmerId).toBe('farmer-a');
    expect(produce.winner.coefficient).toBeCloseTo(93.05, 2);
    expect(produce.winner.scores.money).toBe(100);
    expect(produce.winner.scores.orders).toBe(80);
    expect(produce.winner.scores.quantity).toBeCloseTo(95.24, 2);
  });

  it('returns a null winner rather than inventing one for an empty category', () => {
    const result = buildMonthlyWinners([]);

    // All three, so an empty month renders three "no winner yet" slots rather
    // than a page that silently loses a category.
    expect(result.categories).toHaveLength(3);
    for (const category of result.categories) {
      expect(category.winner).toBeNull();
      expect(category.maxima).toEqual({ revenue: 0, orders: 0, quantity: 0 });
    }
  });

  it('scores each category independently', () => {
    const result = buildMonthlyWinners([
      { category: 'eggs', farmerId: 'a', revenue: 100, orderCount: 5, quantity: 50 },
      { category: 'honey', farmerId: 'b', revenue: 10, orderCount: 1, quantity: 2 },
    ]);

    // A tiny honey producer is the best honey producer. Being outsold by an
    // egg farm is not relevant to a category they are not in.
    expect(result.categories.find((c) => c.category === 'honey').winner.farmerId).toBe('b');
    expect(result.categories.find((c) => c.category === 'eggs').winner.farmerId).toBe('a');
  });
});
