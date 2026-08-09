// The markets page filter bar.
//
// The bar had no layout rule at all: `.search-input-wrapper` asked for
// `flex: 1 1 280px` from a parent that was not a flex container, and
// `.filters-field-narrow` was in the markup but never in the stylesheet. So
// the three controls stacked full width, and the search input drew a pill
// border inside the rounded box its own wrapper had already drawn.
//
// Layout is not testable here, but the behaviour the layout exists to serve
// is: three filters that combine, and an honest empty state when they leave
// nothing. These are what stop a future tidy-up from dropping one.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import MarketsPage from '../pages/MarketsPage.jsx';

vi.mock('../lib/auth.jsx', () => ({
  useAuth: () => ({ status: 'guest', user: null }),
}));

const product = (overrides) => ({
  id: 'p-1',
  name: 'Tomatoes',
  price: 8,
  unit: 'kg',
  quantity: 20,
  rating: 4.6,
  vendor: { id: 'v-1', name: 'Green Farm', city: 'Cluj' },
  ...overrides,
});

const MARKETS = {
  markets: [
    {
      id: 'm-1',
      name: 'Cluj market',
      activeGrowers: 3,
      totalProducts: 3,
      biggestRating: '4.6',
      products: [
        product({ id: 'p-1', name: 'Tomatoes', price: 8, rating: 4.6 }),
        product({ id: 'p-2', name: 'Cucumbers', price: 22, rating: 4.9 }),
        product({ id: 'p-3', name: 'Carrots', price: 5, rating: 3.1 }),
      ],
    },
  ],
};

const renderMarkets = () =>
  render(
    <MemoryRouter initialEntries={['/markets/fruits_and_vegetables']}>
      <Routes>
        <Route path="/markets/:category" element={<MarketsPage />} />
      </Routes>
    </MemoryRouter>,
  );

describe('MarketsPage filters', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input) => {
        const url = String(typeof input === 'string' ? input : input.url);
        if (url.includes('/api/markets/')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(MARKETS) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('offers all three filters', async () => {
    renderMarkets();

    expect(await screen.findByText('Tomatoes')).toBeInTheDocument();
    expect(screen.getByLabelText(/search products/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/max price/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/min rating/i)).toBeInTheDocument();
  });

  it('narrows by name', async () => {
    renderMarkets();
    await screen.findByText('Tomatoes');

    fireEvent.change(screen.getByLabelText(/search products/i), { target: { value: 'carr' } });

    expect(screen.getByText('Carrots')).toBeInTheDocument();
    expect(screen.queryByText('Tomatoes')).not.toBeInTheDocument();
  });

  it('narrows by price ceiling, inclusively', async () => {
    renderMarkets();
    await screen.findByText('Tomatoes');

    fireEvent.change(screen.getByLabelText(/max price/i), { target: { value: '8' } });

    // 8.00 is "max 8", not "under 8".
    expect(screen.getByText('Tomatoes')).toBeInTheDocument();
    expect(screen.getByText('Carrots')).toBeInTheDocument();
    expect(screen.queryByText('Cucumbers')).not.toBeInTheDocument();
  });

  it('narrows by rating', async () => {
    renderMarkets();
    await screen.findByText('Tomatoes');

    fireEvent.change(screen.getByLabelText(/min rating/i), { target: { value: '4.5' } });

    expect(screen.getByText('Tomatoes')).toBeInTheDocument();
    expect(screen.getByText('Cucumbers')).toBeInTheDocument();
    expect(screen.queryByText('Carrots')).not.toBeInTheDocument();
  });

  /** The two side-by-side filters have to compose, not override each other. */
  it('combines price and rating', async () => {
    renderMarkets();
    await screen.findByText('Tomatoes');

    fireEvent.change(screen.getByLabelText(/max price/i), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText(/min rating/i), { target: { value: '4' } });

    expect(screen.getByText('Tomatoes')).toBeInTheDocument();
    expect(screen.queryByText('Cucumbers')).not.toBeInTheDocument();
    expect(screen.queryByText('Carrots')).not.toBeInTheDocument();
  });

  it('says the filters are what emptied the list, not the market', async () => {
    renderMarkets();
    await screen.findByText('Tomatoes');

    fireEvent.change(screen.getByLabelText(/max price/i), { target: { value: '0.5' } });

    await waitFor(() =>
      expect(screen.getByText(/no products match your filters/i)).toBeInTheDocument(),
    );
  });

  it('an empty price box means no ceiling at all', async () => {
    renderMarkets();
    await screen.findByText('Tomatoes');

    fireEvent.change(screen.getByLabelText(/max price/i), { target: { value: '6' } });
    expect(screen.queryByText('Tomatoes')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/max price/i), { target: { value: '' } });
    expect(screen.getByText('Tomatoes')).toBeInTheDocument();
    expect(screen.getByText('Cucumbers')).toBeInTheDocument();
  });
});
