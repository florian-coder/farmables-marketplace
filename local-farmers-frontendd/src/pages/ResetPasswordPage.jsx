import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import { apiFetch } from '../lib/api.js';

export default function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get('token') || '';

  const [form, setForm] = useState({ newPassword: '', confirmPassword: '' });
  const [status, setStatus] = useState({ state: 'idle', message: '' });

  const handleChange = (event) => {
    const { name, value } = event.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();

    if (form.newPassword !== form.confirmPassword) {
      setStatus({ state: 'error', message: 'The two passwords do not match.' });
      return;
    }

    setStatus({ state: 'loading', message: '' });
    try {
      const response = await apiFetch('/api/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({ token, newPassword: form.newPassword }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Unable to reset the password.');
      }
      setStatus({
        state: 'success',
        message: 'Password changed. Every other device has been signed out.',
      });
      setTimeout(() => navigate('/auth/login'), 2200);
    } catch (error) {
      setStatus({ state: 'error', message: error.message || 'Unable to reset the password.' });
    }
  };

  if (!token) {
    return (
      <div className="page-section auth-section">
        <h1>Link incomplete</h1>
        <p className="muted">
          This reset link is missing its token. Ask for a new one — links expire after 30 minutes.
        </p>
        <Link className="button primary" to="/auth/forgot-password">
          Request a new link
        </Link>
      </div>
    );
  }

  return (
    <div className="page-section auth-section">
      <div className="section-header">
        <div>
          <h1>Choose a new password</h1>
          <p className="muted">At least 10 characters. Signing in again everywhere is required.</p>
        </div>
      </div>

      <form className="profile-card" onSubmit={handleSubmit}>
        <header className="profile-card-head">
          <h2>New password</h2>
          <p className="profile-card-sub">
            Setting it signs out every device, including anyone who should not be there.
          </p>
        </header>
        <div className="profile-card-body">
          <div className="profile-fields">
            <label className="field">
              New password
              <input
                type="password"
                name="newPassword"
                autoComplete="new-password"
                minLength={10}
                value={form.newPassword}
                onChange={handleChange}
                required
              />
            </label>
            <label className="field">
              Repeat new password
              <input
                type="password"
                name="confirmPassword"
                autoComplete="new-password"
                minLength={10}
                value={form.confirmPassword}
                onChange={handleChange}
                required
              />
            </label>
          </div>

          <div className="profile-card-foot">
            <button className="button primary" type="submit" disabled={status.state === 'loading'}>
              {status.state === 'loading' ? 'Saving...' : 'Set new password'}
            </button>
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
