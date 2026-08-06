import { useState } from 'react';

import { apiFetch } from '../lib/api.js';

const emptyForm = {
  currentPassword: '',
  newPassword: '',
  confirmPassword: '',
};

export default function PasswordChangeCard() {
  const [form, setForm] = useState(emptyForm);
  const [status, setStatus] = useState({ state: 'idle', message: '' });

  const handleChange = (event) => {
    const { name, value } = event.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();

    if (form.newPassword !== form.confirmPassword) {
      setStatus({ state: 'error', message: 'The new passwords do not match.' });
      return;
    }

    setStatus({ state: 'loading', message: '' });
    try {
      const response = await apiFetch('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({
          currentPassword: form.currentPassword,
          newPassword: form.newPassword,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Unable to change password.');
      }

      setForm(emptyForm);
      setStatus({ state: 'success', message: 'Password changed. Use it the next time you log in.' });
    } catch (error) {
      setStatus({ state: 'error', message: error.message || 'Unable to change password.' });
    }
  };

  return (
    <form className="profile-card" onSubmit={handleSubmit}>
      <header className="profile-card-head">
        <h2>Password</h2>
        <p className="profile-card-sub">
          Enter your current password to set a new one. At least 6 characters.
        </p>
      </header>
      <div className="profile-card-body">
        <div className="profile-fields">
          <label className="field is-wide">
            Current password
            <input
              type="password"
              name="currentPassword"
              autoComplete="current-password"
              value={form.currentPassword}
              onChange={handleChange}
              required
            />
          </label>
          <label className="field">
            New password
            <input
              type="password"
              name="newPassword"
              autoComplete="new-password"
              minLength={6}
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
              minLength={6}
              value={form.confirmPassword}
              onChange={handleChange}
              required
            />
          </label>
        </div>

        <div className="profile-card-foot">
          <button className="button primary" type="submit" disabled={status.state === 'loading'}>
            {status.state === 'loading' ? 'Changing...' : 'Change password'}
          </button>
          {status.message && (
            <p
              className={`notice ${status.state === 'error' ? 'error' : 'success'}`}
              role={status.state === 'error' ? 'alert' : 'status'}
            >
              {status.message}
            </p>
          )}
        </div>
      </div>
    </form>
  );
}
