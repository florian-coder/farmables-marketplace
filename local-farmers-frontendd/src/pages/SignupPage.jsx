import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { apiFetch } from '../lib/api.js';

const initialForm = {
  username: '',
  password: '',
  role: 'customer',
};

export default function SignupPage() {
  const [searchParams] = useSearchParams();
  const [form, setForm] = useState(initialForm);
  const [status, setStatus] = useState({ state: 'idle', message: '' });

  useEffect(() => {
    const role = searchParams.get('role');
    if (role === 'vendor' || role === 'customer') {
      setForm((prev) => ({ ...prev, role }));
    }
  }, [searchParams]);

  const handleChange = (event) => {
    const { name, value } = event.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setStatus({ state: 'loading', message: 'Creating account...' });

    try {
      const response = await apiFetch('/api/auth/signup', {
        method: 'POST',
        body: JSON.stringify(form),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Signup failed.');
      }

      setStatus({
        state: 'success',
        message: 'Account created. You can log in now.',
      });
      setForm((prev) => ({ ...prev, password: '' }));
    } catch (error) {
      setStatus({
        state: 'error',
        message: error.message || 'Signup failed.',
      });
    }
  };

  return (
    <div className="page-section auth-section">
      <div className="section-header">
        <div>
          <h1>Create your account</h1>
          <p className="muted">Choose a role and start collaborating.</p>
        </div>
        <Link className="button ghost" to="/auth/login">
          Log in
        </Link>
      </div>

      <form className="form-card" onSubmit={handleSubmit}>
        <label className="field">
          Username
          <input
            type="text"
            name="username"
            value={form.username}
            onChange={handleChange}
            required
            minLength={3}
          />
        </label>
        <label className="field">
          Password
          <input
            type="password"
            name="password"
            value={form.password}
            onChange={handleChange}
            required
            minLength={6}
          />
        </label>
        <label className="field">
          Role
          <select name="role" value={form.role} onChange={handleChange}>
            <option value="customer">Customer</option>
            <option value="vendor">Vendor</option>
          </select>
        </label>
        <button className="button primary" type="submit" disabled={status.state === 'loading'}>
          {status.state === 'loading' ? 'Creating...' : 'Sign up'}
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
          Already have an account? <Link to="/auth/login">Log in</Link>.
        </p>
      </form>
    </div>
  );
}
