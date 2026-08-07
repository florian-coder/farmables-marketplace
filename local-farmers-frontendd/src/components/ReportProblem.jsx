// OPS-03 — "something is wrong with this order".
//
// Placed on the order card, where the problem is, rather than behind a help
// page. A customer who has to go looking for the complaint form is a customer
// who charges back instead — which costs everyone more, and tells us nothing.
//
// The categories are the ones that map to an actual remedy. "Other" exists
// because a fixed list always misses something, but it is last.

import { useState } from 'react';

import { apiFetch } from '../lib/api.js';

const CATEGORIES = [
  { value: 'not_delivered', label: 'It never arrived' },
  { value: 'missing_items', label: 'Something was missing' },
  { value: 'quality', label: 'The quality was not acceptable' },
  { value: 'wrong_items', label: 'I received the wrong items' },
  { value: 'other', label: 'Something else' },
];

export default function ReportProblem({ order, onOpened }) {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState('missing_items');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState({ state: 'idle', message: '' });

  // The window opens at delivery and closes when the order is confirmed —
  // the same clock the auto-confirm job uses, deliberately.
  const canReport = order.orderState === 'arrived' || order.orderState === 'received';
  if (!canReport) {
    return null;
  }

  const handleSubmit = async (event) => {
    event.preventDefault();
    setStatus({ state: 'loading', message: '' });
    try {
      const response = await apiFetch('/api/disputes', {
        method: 'POST',
        body: JSON.stringify({ orderId: order.id, category, description }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Could not open the case.');
      }
      setStatus({
        state: 'success',
        message:
          'Reported. The farm has 48 hours to respond — if they do not, we take it from there.',
      });
      setOpen(false);
      onOpened?.(data.dispute);
    } catch (error) {
      setStatus({ state: 'error', message: error.message });
    }
  };

  if (status.state === 'success') {
    return (
      <p className="notice ok order-dispute-notice" role="status">
        {status.message}
      </p>
    );
  }

  return (
    <div className="order-dispute">
      {!open ? (
        <button className="button quiet small" type="button" onClick={() => setOpen(true)}>
          Report a problem
        </button>
      ) : (
        <form className="order-dispute-form" onSubmit={handleSubmit}>
          <label>
            What went wrong?
            <select value={category} onChange={(event) => setCategory(event.target.value)}>
              {CATEGORIES.map((entry) => (
                <option key={entry.value} value={entry.value}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>

          <label>
            Tell us what happened
            <textarea
              rows={3}
              value={description}
              maxLength={2000}
              placeholder="What was missing, or what was wrong with it?"
              onChange={(event) => setDescription(event.target.value)}
              required
            />
          </label>

          <p className="muted order-dispute-hint">
            Photographs help enormously — you can add them to the case once it is open.
          </p>

          <div className="order-dispute-actions">
            <button className="button quiet small" type="button" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button className="button primary small" type="submit" disabled={status.state === 'loading'}>
              {status.state === 'loading' ? 'Sending...' : 'Report the problem'}
            </button>
          </div>

          {status.state === 'error' && (
            <p className="notice error" role="alert">
              {status.message}
            </p>
          )}
        </form>
      )}
    </div>
  );
}
