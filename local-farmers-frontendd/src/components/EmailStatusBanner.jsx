// SEC-09b — telling people about a missing address before checkout does.
//
// Two different problems, two different messages:
//
//   `missing`     — the account is on a legacy `@localfarmers.app` address
//                   that accepts no mail. Nothing we send will ever arrive,
//                   and checkout will refuse. Blocking, so the banner asks
//                   for an address inline rather than sending them hunting.
//   `unverified`  — a real address, link not clicked. Not blocking. A quiet
//                   nudge with a resend button, dismissible.
//
// Discovering at the payment step that you cannot pay is the worst possible
// moment to find out, which is the entire reason this exists.

import { useState } from 'react';

import { apiFetch } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';

export default function EmailStatusBanner() {
  const { status, user, refresh } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [feedback, setFeedback] = useState({ state: 'idle', message: '' });

  if (status !== 'authenticated') {
    return null;
  }

  const emailStatus = user?.emailStatus;
  if (emailStatus !== 'missing' && emailStatus !== 'unverified') {
    return null;
  }
  // Only the non-blocking one can be dismissed.
  if (emailStatus === 'unverified' && dismissed) {
    return null;
  }

  const handleSave = async (event) => {
    event.preventDefault();
    setFeedback({ state: 'loading', message: '' });
    try {
      const response = await apiFetch('/api/auth/email', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Could not save the address.');
      }
      setFeedback({
        state: 'success',
        message: 'Saved. Check your inbox for the confirmation link.',
      });
      setPassword('');
      setFormOpen(false);
      await refresh();
    } catch (error) {
      setFeedback({ state: 'error', message: error.message });
      setPassword('');
    }
  };

  const handleResend = async () => {
    setFeedback({ state: 'loading', message: '' });
    try {
      const response = await apiFetch('/api/auth/resend-verification', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Could not send the link.');
      }
      setFeedback({ state: 'success', message: 'Sent. Check your inbox.' });
    } catch (error) {
      setFeedback({ state: 'error', message: error.message });
    }
  };

  if (emailStatus === 'unverified') {
    return (
      <div className="email-banner is-soft" role="status">
        <div className="email-banner-inner">
          <span className="email-banner-icon" aria-hidden="true">
            <EnvelopeIcon />
          </span>
          <div className="email-banner-copy">
            <p className="email-banner-title">Confirm your email address</p>
            <p className="email-banner-detail">
              We sent a link to <span className="email-banner-address">{user.email}</span>. Open it
              and we can keep you posted on your orders.
            </p>
            {feedback.message && (
              <p
                className={`email-banner-feedback${feedback.state === 'error' ? ' is-error' : ''}`}
                role={feedback.state === 'error' ? 'alert' : 'status'}
              >
                {feedback.message}
              </p>
            )}
          </div>
          <div className="email-banner-actions">
            <button
              className="button ghost small"
              type="button"
              onClick={handleResend}
              disabled={feedback.state === 'loading'}
            >
              {feedback.state === 'loading' ? 'Sending…' : 'Resend link'}
            </button>
            {/* Dismiss, not "Later": an X reads as "hide this", which is what
                it does. "Later" reads like a promise to come back. */}
            <button
              className="email-banner-dismiss"
              type="button"
              onClick={() => setDismissed(true)}
              aria-label="Dismiss this reminder"
              title="Dismiss"
            >
              <CloseIcon />
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="email-banner is-hard" role="alert">
      <div className="email-banner-inner">
        <span className="email-banner-icon" aria-hidden="true">
          <AlertIcon />
        </span>
        <div className="email-banner-copy">
          <p className="email-banner-title">We have no email address for you</p>
          <p className="email-banner-detail">
            This account was created before we collected one, so nothing we send can reach you —
            and we cannot take an order we are unable to confirm.
          </p>

          {formOpen && (
            <form className="email-banner-form" onSubmit={handleSave}>
              <label className="field">
                Email address
                <input
                  type="email"
                  value={email}
                  autoComplete="email"
                  onChange={(event) => setEmail(event.target.value)}
                  required
                />
              </label>
              <label className="field">
                {/* Email is the password-reset channel, so changing it needs the
                    password — otherwise a borrowed laptop is a takeover. */}
                Your password
                <input
                  type="password"
                  value={password}
                  autoComplete="current-password"
                  onChange={(event) => setPassword(event.target.value)}
                  required
                />
              </label>
              <button
                className="button primary small"
                type="submit"
                disabled={feedback.state === 'loading'}
              >
                {feedback.state === 'loading' ? 'Saving…' : 'Save'}
              </button>
            </form>
          )}

          {feedback.message && (
            <p
              className={`email-banner-feedback${feedback.state === 'error' ? ' is-error' : ''}`}
              role={feedback.state === 'error' ? 'alert' : 'status'}
            >
              {feedback.message}
            </p>
          )}
        </div>

        {!formOpen && (
          <div className="email-banner-actions">
            <button className="button primary small" type="button" onClick={() => setFormOpen(true)}>
              Add my email address
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/* Inline SVG rather than an emoji: it inherits `currentColor`, so one icon
   works in both themes and in both banner variants without a second asset. */
const EnvelopeIcon = () => (
  <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6">
    <rect x="2.2" y="4.2" width="15.6" height="11.6" rx="2" />
    <path d="m2.8 5.4 6.3 4.7a1.5 1.5 0 0 0 1.8 0l6.3-4.7" strokeLinecap="round" />
  </svg>
);

const AlertIcon = () => (
  <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6">
    <circle cx="10" cy="10" r="7.8" />
    <path d="M10 6v4.6" strokeLinecap="round" />
    <circle cx="10" cy="13.7" r="0.9" fill="currentColor" stroke="none" />
  </svg>
);

const CloseIcon = () => (
  <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8">
    <path d="m6 6 8 8M14 6l-8 8" strokeLinecap="round" />
  </svg>
);
