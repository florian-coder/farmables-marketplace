import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import App from '../App.jsx';

describe('App', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input) => {
        const url = typeof input === 'string' ? input : input.url;

        if (url.includes('/api/auth/me')) {
          return Promise.resolve({
            ok: false,
            status: 401,
            json: () => Promise.resolve({ error: 'Unauthorized' }),
          });
        }

        if (url.includes('/api/markets/home-insights')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                generatedAt: '2026-03-05T10:00:00.000Z',
                dailyRecommendations: {
                  fruits_and_vegetables: {
                    category: 'fruits_and_vegetables',
                    label: 'Fruits & Vegetables',
                    products: [
                      {
                        id: 'fv-1',
                        name: 'Sunny Tomatoes',
                        price: 5.2,
                        unit: 'kg',
                        isBio: true,
                        vendorName: 'Green Farm',
                        image: null,
                      },
                    ],
                  },
                  honey: {
                    category: 'honey',
                    label: 'Honey',
                    products: [
                      {
                        id: 'h-1',
                        name: 'Raw Acacia Honey',
                        price: 8.4,
                        unit: 'jar',
                        isBio: true,
                        vendorName: 'Apiary Vale',
                        image: null,
                      },
                    ],
                  },
                  eggs: {
                    category: 'eggs',
                    label: 'Eggs',
                    products: [
                      {
                        id: 'e-1',
                        name: 'Free-Range Eggs',
                        price: 5.7,
                        unit: 'dozen',
                        isBio: true,
                        vendorName: 'Oak Poultry',
                        image: null,
                      },
                    ],
                  },
                },
                farmerOfMonth: {
                  month: '2026-03',
                  weights: { revenue: 0.5, orders: 0.3, quantity: 0.2 },
                  categories: [
                    {
                      category: 'eggs',
                      categoryLabel: 'Eggs',
                      winner: {
                        farmerId: 'f1',
                        farmerName: 'Alex Pop',
                        farmName: 'Oak Ranch',
                        metrics: { revenue: 1200, orders: 40, quantity: 230 },
                        coefficient: 94.2,
                      },
                    },
                    {
                      category: 'fruits_and_vegetables',
                      categoryLabel: 'Fruits & Vegetables',
                      winner: null,
                    },
                    {
                      category: 'honey',
                      categoryLabel: 'Honey',
                      winner: null,
                    },
                  ],
                },
              }),
          });
        }

        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({}),
        });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the hero headline', () => {
    render(<App />);

    expect(
      screen.getByRole('heading', {
        name: /food that still remembers the field/i,
      }),
    ).toBeInTheDocument();
  });

  it('switches daily recommendations when changing tabs', async () => {
    render(<App />);

    expect(await screen.findByText(/sunny tomatoes/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /eggs/i }));

    expect(await screen.findByText(/free-range eggs/i)).toBeInTheDocument();
  });

  it('expands FAQ answers in accordion mode', async () => {
    render(<App />);

    const trigger = await screen.findByRole('button', { name: /who runs this\?/i });
    fireEvent.click(trigger);

    expect(
      screen.getByText(/a two-person team that wants only the best opportunities/i),
    ).toBeInTheDocument();
  });
});
