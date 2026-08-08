// LEG-03 — the two GDPR rights that have to be a button, not an email.
//
// Art. 20 (portability) and Art. 17 (erasure) are the rights where making
// someone ask permission defeats the point. Both live here, on the profile
// page, next to the password.
//
// The deletion flow shows what will and will not be erased *before* asking
// for confirmation. "Delete my account" means different things to different
// people, and the gap between what someone expects and what accounting law
// allows is exactly where trust is lost — so we say it plainly rather than
// letting them discover it later.

import { useState } from 'react';
import { Link } from 'react-router-dom';

import { apiFetch } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';

export default function PrivacyCard() {
  const { logout } = useAuth();
  const [exportStatus, setExportStatus] = useState({ state: 'idle', message: '' });
  const [deleteStatus, setDeleteStatus] = useState({ state: 'idle', message: '' });
  const [plan, setPlan] = useState(null);
  const [password, setPassword] = useState('');

  const handleExport = async () => {
    setExportStatus({ state: 'loading', message: 'Gathering your data...' });
    try {
      const response = await apiFetch('/api/profile/export', { method: 'GET' });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Could not prepare your data.');
      }

      // A file the person walks away with, not a wall of JSON in a tab.
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'farmables-my-data.json';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);

      setExportStatus({ state: 'success', message: 'Downloaded.' });
    } catch (error) {
      setExportStatus({ state: 'error', message: error.message || 'Could not prepare your data.' });
    }
  };

  /** Step one: show what deletion actually does. No confirmation yet. */
  const handleShowPlan = async () => {
    setDeleteStatus({ state: 'loading', message: '' });
    try {
      const response = await apiFetch('/api/profile/deletion-plan', { method: 'GET' });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Could not load the deletion details.');
      }
      setPlan(data.plan);
      setDeleteStatus({ state: 'idle', message: '' });
    } catch (error) {
      setDeleteStatus({ state: 'error', message: error.message });
    }
  };

  const handleDelete = async (event) => {
    event.preventDefault();
    setDeleteStatus({ state: 'loading', message: 'Deleting your account...' });
    try {
      const response = await apiFetch('/api/profile/delete', {
        method: 'POST',
        body: JSON.stringify({ password }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Could not delete the account.');
      }
      // The session is already dead server-side; this clears it here too.
      await logout();
      window.location.href = '/';
    } catch (error) {
      setDeleteStatus({ state: 'error', message: error.message });
      setPassword('');
    }
  };

  return (
    <section className="profile-card">
      <header className="profile-card-head">
        <h2>Your data</h2>
        <p className="profile-card-sub">
          What we hold about you, and what happens to it. The{' '}
          <Link to="/legal/privacy">privacy policy</Link> has the full detail.
        </p>
      </header>

      <div className="profile-card-body">
        <div className="privacy-action">
          <span className="privacy-action-icon" aria-hidden="true">
            <DownloadIcon />
          </span>
          <div className="privacy-action-copy">
            <h3>Download your data</h3>
            <p>
              Everything we hold that identifies you, as a JSON file. Messages other people wrote
              are not included — those are their data, not yours.
            </p>
          </div>
          <button
            className="button ghost small"
            type="button"
            onClick={handleExport}
            disabled={exportStatus.state === 'loading'}
          >
            {exportStatus.state === 'loading' ? 'Preparing…' : 'Download'}
          </button>
        </div>

        {exportStatus.state === 'error' && (
          <p className="notice error" role="alert">
            {exportStatus.message}
          </p>
        )}

        <div className="privacy-action is-danger">
          <span className="privacy-action-icon" aria-hidden="true">
            <TrashIcon />
          </span>
          <div className="privacy-action-copy">
            <h3>Delete your account</h3>
            <p>
              This cannot be undone. We will show you exactly what is erased and what we are
              legally required to keep before you confirm.
            </p>
          </div>
          {!plan && (
            <button className="button danger small" type="button" onClick={handleShowPlan}>
              Delete my account
            </button>
          )}
        </div>

        {plan && (
          <div className="privacy-plan">
            {/* Two columns, side by side on purpose: the honest comparison is
                what this screen is for, and stacking them turns it into a
                long scroll where the second list reads as an afterthought. */}
            <div className="privacy-plan-grid">
              <section className="privacy-plan-column is-erased">
                <h4>What gets erased</h4>
                <ul>
                  {plan.erased.map((entry) => (
                    <li key={entry}>{entry}</li>
                  ))}
                </ul>
              </section>

              <section className="privacy-plan-column is-kept">
                <h4>What we have to keep</h4>
                <p className="privacy-plan-note">
                  These records stop pointing at you — they refer to an anonymous handle that leads
                  nowhere. We keep them because the law requires it, not because we want to.
                </p>
                <ul>
                  {plan.kept.map((entry) => (
                    <li key={entry}>{entry}</li>
                  ))}
                </ul>
              </section>
            </div>

            <form className="privacy-confirm" onSubmit={handleDelete}>
              <label className="field" htmlFor="delete-password">
                Enter your password to confirm
                <input
                  id="delete-password"
                  type="password"
                  value={password}
                  autoComplete="current-password"
                  onChange={(event) => setPassword(event.target.value)}
                  required
                />
              </label>

              <div className="privacy-confirm-actions">
                {/* Keeping the account is the default-looking button. The
                    destructive one has to be reached for, not fallen into. */}
                <button
                  className="button ghost"
                  type="button"
                  onClick={() => {
                    setPlan(null);
                    setPassword('');
                    setDeleteStatus({ state: 'idle', message: '' });
                  }}
                >
                  Keep my account
                </button>
                <button
                  className="button danger"
                  type="submit"
                  disabled={deleteStatus.state === 'loading' || !password}
                >
                  {deleteStatus.state === 'loading' ? 'Deleting…' : 'Delete permanently'}
                </button>
              </div>
            </form>
          </div>
        )}

        {deleteStatus.state === 'error' && (
          <p className="notice error" role="alert">
            {deleteStatus.message}
          </p>
        )}
      </div>
    </section>
  );
}

const DownloadIcon = () => (
  <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6">
    <path d="M10 3.2v9" strokeLinecap="round" />
    <path d="m6.3 8.8 3.7 3.7 3.7-3.7" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M3.6 14.2v1.4a1.4 1.4 0 0 0 1.4 1.4h10a1.4 1.4 0 0 0 1.4-1.4v-1.4" strokeLinecap="round" />
  </svg>
);

const TrashIcon = () => (
  <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6">
    <path d="M3.6 5.6h12.8" strokeLinecap="round" />
    <path d="M7.6 5.6V4.2a1 1 0 0 1 1-1h2.8a1 1 0 0 1 1 1v1.4" strokeLinecap="round" />
    <path d="M5.4 5.6l.7 10a1.4 1.4 0 0 0 1.4 1.3h5a1.4 1.4 0 0 0 1.4-1.3l.7-10" strokeLinecap="round" />
  </svg>
);
