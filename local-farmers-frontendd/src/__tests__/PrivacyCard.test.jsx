// LEG-03 — the two GDPR rights that have to be a button, not an email.
//
// The property worth testing is not that the card renders: it is that
// deletion cannot happen by accident. Two steps, a password, and the full
// list of what survives shown before the confirm button exists at all.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import PrivacyCard from '../components/PrivacyCard.jsx';

const logout = vi.hoisted(() => vi.fn());

vi.mock('../lib/auth.jsx', () => ({
  useAuth: () => ({ status: 'authenticated', user: { id: '1' }, logout }),
}));

const PLAN = {
  erased: ['users.email', 'customers: name, surname, address'],
  kept: ['orders, prices and quantities — accounting law, 10 years', 'audit log entries'],
};

const renderCard = () =>
  render(
    <MemoryRouter>
      <PrivacyCard />
    </MemoryRouter>,
  );

const respondWith = (handler) => {
  global.fetch = vi.fn(handler);
};

describe('PrivacyCard', () => {
  beforeEach(() => {
    logout.mockClear();
    respondWith(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('offers both rights without making anyone ask for them', () => {
    renderCard();

    expect(screen.getByRole('heading', { name: /download your data/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /delete your account/i })).toBeInTheDocument();
  });

  /**
   * Step one shows the consequences. Nothing on screen can delete anything
   * yet — there is no password field and no confirm button.
   */
  it('shows no way to confirm deletion before the plan has been read', () => {
    renderCard();

    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete permanently/i })).not.toBeInTheDocument();
  });

  it('lists what is erased and what the law makes us keep', async () => {
    respondWith((url) => {
      if (String(url).includes('/api/profile/deletion-plan')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ plan: PLAN }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: /delete my account/i }));

    expect(await screen.findByText('users.email')).toBeInTheDocument();
    // The half people do not expect, stated before they confirm rather than
    // discovered afterwards.
    expect(screen.getByText(/accounting law, 10 years/i)).toBeInTheDocument();
    expect(screen.getByText(/anonymous handle that leads nowhere/i)).toBeInTheDocument();
  });

  it('keeps the confirm button unusable until a password is typed', async () => {
    respondWith((url) => {
      if (String(url).includes('/api/profile/deletion-plan')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ plan: PLAN }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: /delete my account/i }));

    const confirm = await screen.findByRole('button', { name: /delete permanently/i });
    expect(confirm).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/enter your password/i), {
      target: { value: 'hunter2hunter2' },
    });
    expect(confirm).toBeEnabled();
  });

  it('backing out leaves the account alone and asks nothing further', async () => {
    respondWith((url) => {
      if (String(url).includes('/api/profile/deletion-plan')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ plan: PLAN }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: /delete my account/i }));
    fireEvent.click(await screen.findByRole('button', { name: /keep my account/i }));

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /delete permanently/i })).not.toBeInTheDocument(),
    );
    expect(logout).not.toHaveBeenCalled();
  });

  it('reports a wrong password instead of silently doing nothing', async () => {
    respondWith((url) => {
      if (String(url).includes('/api/profile/deletion-plan')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ plan: PLAN }) });
      }
      if (String(url).includes('/api/profile/delete')) {
        return Promise.resolve({
          ok: false,
          status: 401,
          json: () => Promise.resolve({ error: 'That password is not right.' }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: /delete my account/i }));
    fireEvent.change(await screen.findByLabelText(/enter your password/i), {
      target: { value: 'wrong-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: /delete permanently/i }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/that password is not right/i),
    );
    expect(logout).not.toHaveBeenCalled();
  });

  it('surfaces an export failure rather than handing over an empty file', async () => {
    respondWith((url) => {
      if (String(url).includes('/api/profile/export')) {
        return Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.resolve({ error: 'Could not prepare your data.' }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: /^download$/i }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/could not prepare your data/i),
    );
  });
});
