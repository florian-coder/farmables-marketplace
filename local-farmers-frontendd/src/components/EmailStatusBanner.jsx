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
        <p>
          Confirm your email address ({user.email}) so we can send you order updates.
          {feedback.state === 'success' && ` ${feedback.message}`}
          {feedback.state === 'error' && ` ${feedback.message}`}
        </p>
        <div className="email-banner-actions">
          <button
            className="button quiet small"
            type="button"
            onClick={handleResend}
            disabled={feedback.state === 'loading'}
          >
            {feedback.state === 'loading' ? 'Sending...' : 'Resend link'}
          </button>
          <button className="button quiet small" type="button" onClick={() => setDismissed(true)}>
            Later
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="email-banner is-hard" role="alert">
      <p>
        <strong>We have no email address for you.</strong> This account was created before we
        collected one, so nothing we send can reach you — and we cannot take an order we are unable
        to confirm. Add an address to carry on ordering.
      </p>

      {!formOpen && (
        <div className="email-banner-actions">
          <button className="button primary small" type="button" onClick={() => setFormOpen(true)}>
            Add my email address
          </button>
        </div>
      )}

      {formOpen && (
        <form className="email-banner-form" onSubmit={handleSave}>
          <label>
            Email address
            <input
              type="email"
              value={email}
              autoComplete="email"
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </label>
          <label>
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
          <button className="button primary small" type="submit" disabled={feedback.state === 'loading'}>
            {feedback.state === 'loading' ? 'Saving...' : 'Save'}
          </button>
        </form>
      )}

      {feedback.state === 'error' && (
        <p className="email-banner-feedback is-error" role="alert">
          {feedback.message}
        </p>
      )}
      {feedback.state === 'success' && (
        <p className="email-banner-feedback">{feedback.message}</p>
      )}
    </div>
  );
}
