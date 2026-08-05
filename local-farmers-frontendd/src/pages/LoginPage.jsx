import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { apiFetch } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';

const initialForm = {
  username: '',
  password: '',
};

export default function LoginPage() {
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const [form, setForm] = useState(initialForm);
  const [status, setStatus] = useState({ state: 'idle', message: '' });

  const handleChange = (event) => {
    const { name, value } = event.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setStatus({ state: 'loading', message: 'Signing in...' });

    try {
      const response = await apiFetch('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify(form),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Login failed.');
      }

      setStatus({ state: 'success', message: 'Welcome back.' });
      await refresh();
      navigate('/profile');
    } catch (error) {
      setStatus({
        state: 'error',
        message: error.message || 'Login failed.',
      });
    }
  };

  return (
    <div className="page-section auth-section">
      <div className="section-header">
        <div>
          <h1>Log in</h1>
          <p className="muted">Access your dashboard and saved markets.</p>
        </div>
        <Link className="button ghost" to="/auth/signup">
          Create account
        </Link>
      </div>

      <form className="form-card" onSubmit={handleSubmit}>
        <label className="field">
          Username
          <input
            type="text"
            name="username"
            autoComplete="username"
            value={form.username}
            onChange={handleChange}
            required
          />
        </label>
        <label className="field">
          Password
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            value={form.password}
            onChange={handleChange}
            required
          />
        </label>
        <button className="button primary" type="submit" disabled={status.state === 'loading'}>
          {status.state === 'loading' ? 'Signing in...' : 'Log in'}
        </button>
        {status.message && (
          <p
            className={`notice ${
              status.state === 'error' ? 'error' : 'success'
            }`} role="status"
          >
            {status.message}
          </p>
        )}
        <p className="muted">
          New here? <Link to="/auth/signup">Create an account</Link>.
        </p>
      </form>
    </div>
  );
}
