// The upload-product form.
//
// It was one column of twelve equally weighted fields, so the mandatory food
// information — the part the server refuses to publish without — read as a
// footnote to the price. Regrouping it into cards is a layout change, and the
// risk of a layout change to a form is that a field quietly stops being
// wired up. These tests are aimed at exactly that.

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import VendorAddProductPage from '../pages/VendorAddProductPage.jsx';

const auth = vi.hoisted(() => ({
  current: { status: 'authenticated', user: { id: '77', role: 'vendor' } },
}));

vi.mock('../lib/auth.jsx', () => ({
  useAuth: () => auth.current,
}));

const renderPage = () =>
  render(
    <MemoryRouter>
      <VendorAddProductPage />
    </MemoryRouter>,
  );

const approvedVendor = () =>
  vi.stubGlobal(
    'fetch',
    vi.fn((input) => {
      const url = String(typeof input === 'string' ? input : input.url);
      if (url.includes('/api/vendor/profile')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ profileApproved: true }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }),
  );

describe('VendorAddProductPage', () => {
  beforeEach(() => {
    auth.current = { status: 'authenticated', user: { id: '77', role: 'vendor' } };
    approvedVendor();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('turns a customer away rather than showing them a form they cannot submit', () => {
    auth.current = { status: 'authenticated', user: { id: '10', role: 'customer' } };
    renderPage();

    expect(screen.getByRole('heading', { name: /vendor access required/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/product name/i)).not.toBeInTheDocument();
  });

  it('warns an unapproved farm before it fills anything in', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ profileApproved: false }) })),
    );
    renderPage();

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/not approved yet/i),
    );
  });

  /**
   * The point of the regrouping: four named sections instead of one run-on
   * column, with the legally mandatory part given its own heading rather
   * than buried between the photo and a checkbox.
   */
  it('groups the form into named sections', async () => {
    renderPage();

    for (const name of [/what you are selling/i, /price and stock/i, /^photo$/i, /food information/i]) {
      expect(await screen.findByRole('heading', { name })).toBeInTheDocument();
    }
  });

  it('keeps every field wired up after the regrouping', async () => {
    renderPage();

    fireEvent.change(await screen.findByLabelText(/product name/i), {
      target: { value: 'Cherry tomatoes' },
    });
    // Anchored at the start only: this codebase puts the hint text inside the
    // label, so the accessible name is "Category" followed by the hint.
    fireEvent.change(screen.getByLabelText(/^category/i), { target: { value: 'honey' } });
    fireEvent.change(screen.getByLabelText(/^variety or type/i), { target: { value: 'Acacia' } });
    fireEvent.change(screen.getByLabelText(/^price/i), { target: { value: '12.50' } });
    fireEvent.change(screen.getByLabelText(/^unit$/i), { target: { value: 'jar' } });
    fireEvent.change(screen.getByLabelText(/quantity in stock/i), { target: { value: '40' } });
    fireEvent.change(screen.getByLabelText(/^batch code/i), { target: { value: 'B-2026-08' } });

    expect(screen.getByLabelText(/product name/i)).toHaveValue('Cherry tomatoes');
    expect(screen.getByLabelText(/^category/i)).toHaveValue('honey');
    expect(screen.getByLabelText(/^variety or type/i)).toHaveValue('Acacia');
    expect(screen.getByLabelText(/^price/i)).toHaveValue(12.5);
    expect(screen.getByLabelText(/^unit$/i)).toHaveValue('jar');
    expect(screen.getByLabelText(/quantity in stock/i)).toHaveValue(40);
    expect(screen.getByLabelText(/^batch code/i)).toHaveValue('B-2026-08');
  });

  it('starts a listing visible and instantly buyable', async () => {
    renderPage();

    expect(await screen.findByLabelText(/available now/i)).toBeChecked();
    expect(screen.getByLabelText(/instant buy/i)).toBeChecked();
  });

  it('both toggles can be turned off independently', async () => {
    renderPage();

    fireEvent.click(await screen.findByLabelText(/available now/i));

    expect(screen.getByLabelText(/available now/i)).not.toBeChecked();
    expect(screen.getByLabelText(/instant buy/i)).toBeChecked();
  });

  /** LEG-04 — the label fields follow the category, not the other way round. */
  it('swaps the label fields when the category changes', async () => {
    renderPage();

    fireEvent.change(await screen.findByLabelText(/^category/i), { target: { value: 'eggs' } });
    const labelSection = screen.getByRole('heading', { name: /food information/i }).closest('section');

    // Reg. 589/2008 — eggs carry a farming method and a grading, and nothing
    // else in the catalogue does.
    expect(within(labelSection).getByText(/farming method/i)).toBeInTheDocument();
  });

  it('shows the currency next to the price, so the number is not bare', async () => {
    renderPage();
    const price = await screen.findByLabelText(/^price/i);

    expect(price.closest('.input-affix')).toHaveTextContent('RON');
  });
});
