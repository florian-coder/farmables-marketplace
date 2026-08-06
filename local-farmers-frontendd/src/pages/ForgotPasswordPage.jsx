import { useState } from 'react';
import { Link } from 'react-router-dom';

import { apiFetch } from '../lib/api.js';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState({ state: 'idle', message: '' });

  const handleSubmit = async (event) => {
    event.preventDefault();
    setStatus({ state: 'loading', message: '' });

    try {
      const response = await apiFetch('/api/auth/forgot-password', {
        method: 'POST',
        body: JSON.stringify({ email }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Unable to send the reset link.');
      }
      setStatus({
        state: 'success',
        message:
          'If an account uses that address, a reset link is on its way. The link works once and expires in 30 minutes.',
      });
    } catch (error) {
      setStatus({ state: 'error', message: error.message || 'Unable to send the reset link.' });
    }
  };

  return (
    <div className="page-section auth-section">
      <div className="section-header">
        <div>
          <h1>Forgot your password?</h1>
          <p className="muted">
            Enter the email on your account and we send you a link to set a new password.
          </p>
        </div>
      </div>

      <form className="profile-card" onSubmit={handleSubmit}>
        <header className="profile-card-head">
          <h2>Reset link</h2>
          <p className="profile-card-sub">The link works once and expires in 30 minutes.</p>
        </header>
        <div className="profile-card-body">
          <div className="profile-fields">
            <label className="field is-wide">
              Email
              <input
                type="email"
                name="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </label>
          </div>

          <div className="profile-card-foot">
            <button className="button primary" type="submit" disabled={status.state === 'loading'}>
              {status.state === 'loading' ? 'Sending...' : 'Send reset link'}
            </button>
            <Link className="button ghost" to="/auth/login">
              Back to log in
            </Link>
          </div>

          {status.message && (
            <p
              className={`notice ${status.state === 'error' ? 'error' : 'success'}`}
              role={status.state === 'error' ? 'alert' : 'status'}
            >
              {status.message}
            </p>
          )}
        </div>
      </form>
    </div>
  );
}
