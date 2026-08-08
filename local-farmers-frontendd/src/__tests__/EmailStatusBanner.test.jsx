// SEC-09b — the banner that stops someone discovering at the payment step
// that they cannot pay.
//
// The two variants are not two skins of one message; they are two different
// situations with two different exits, and the tests keep them apart. The
// blocking one must not be dismissible — a nudge you can wave away is the
// wrong shape for "we physically cannot reach you".

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import EmailStatusBanner from '../components/EmailStatusBanner.jsx';

const mockAuth = vi.hoisted(() => ({ current: { status: 'guest', user: null } }));

vi.mock('../lib/auth.jsx', () => ({
  useAuth: () => ({ ...mockAuth.current, refresh: vi.fn() }),
}));

const signedInWith = (emailStatus, email = 'florian.susai@gmail.com') => {
  mockAuth.current = {
    status: 'authenticated',
    user: { id: '1', email, emailStatus },
  };
};

describe('EmailStatusBanner', () => {
  beforeEach(() => {
    mockAuth.current = { status: 'guest', user: null };
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows nothing to a signed-out visitor', () => {
    const { container } = render(<EmailStatusBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows nothing once the address is verified', () => {
    signedInWith('verified');
    const { container } = render(<EmailStatusBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('names the address it sent the link to, so it can be checked at a glance', () => {
    signedInWith('unverified');
    render(<EmailStatusBanner />);

    expect(screen.getByText('Confirm your email address')).toBeInTheDocument();
    expect(screen.getByText('florian.susai@gmail.com')).toBeInTheDocument();
  });

  it('resends the link and reports back in place', async () => {
    signedInWith('unverified');
    render(<EmailStatusBanner />);

    fireEvent.click(screen.getByRole('button', { name: /resend link/i }));

    await waitFor(() => expect(screen.getByText(/check your inbox/i)).toBeInTheDocument());
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/auth/resend-verification'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('surfaces a failure to resend without hiding the banner', async () => {
    signedInWith('unverified');
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 429,
        json: () => Promise.resolve({ error: 'Too many requests. Try again in a minute.' }),
      }),
    );
    render(<EmailStatusBanner />);

    fireEvent.click(screen.getByRole('button', { name: /resend link/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/too many requests/i));
    expect(screen.getByText('Confirm your email address')).toBeInTheDocument();
  });

  it('can be dismissed, because an unverified address is a nudge, not a wall', () => {
    signedInWith('unverified');
    const { container } = render(<EmailStatusBanner />);

    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));

    expect(container).toBeEmptyDOMElement();
  });

  /**
   * The blocking variant. A missing address is not a reminder: checkout will
   * refuse, so there is nothing to postpone and no dismiss button to offer.
   */
  it('offers no way out when there is no address at all', () => {
    signedInWith('missing', 'legacy@localfarmers.app');
    render(<EmailStatusBanner />);

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('We have no email address for you')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /dismiss/i })).not.toBeInTheDocument();
  });

  it('asks for the password alongside the new address', () => {
    signedInWith('missing', 'legacy@localfarmers.app');
    render(<EmailStatusBanner />);

    fireEvent.click(screen.getByRole('button', { name: /add my email address/i }));

    // Email is the password-reset channel: changing it without the password
    // would make a borrowed laptop an account takeover.
    expect(screen.getByLabelText(/email address/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/your password/i)).toBeInTheDocument();
  });
});
