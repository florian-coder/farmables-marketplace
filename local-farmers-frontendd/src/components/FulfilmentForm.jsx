// OPS-06 + LOG-04 — the farmer records what actually went in the box.
//
// Before this, a farm with 3 of 5 kilos could only decline the whole order,
// which served nobody: the customer gets nothing, the farm gets nothing, and
// the 3 kilos go to waste.
//
// The form pre-fills with what was ordered, so a farm that shorted two items
// out of ten changes two numbers. Small differences are absorbed by the ±10%
// tolerance and cost nothing; anything beyond it is refunded automatically,
// and the form says so before it is submitted rather than after.

import { useMemo, useState } from 'react';

import { apiFetch } from '../lib/api.js';

const TOLERANCE = 0.1;

const formatBani = (bani) => `${(Number(bani || 0) / 100).toFixed(2)} RON`;

export default function FulfilmentForm({ order, onRecorded }) {
  const [open, setOpen] = useState(false);
  const [quantities, setQuantities] = useState(() =>
    Object.fromEntries((order.items || []).map((item) => [item.id, String(item.quantity)])),
  );
  const [status, setStatus] = useState({ state: 'idle', message: '' });

  // The same arithmetic the server will do, so the farm sees the consequence
  // before committing rather than discovering it in a refund notification.
  const preview = useMemo(() => {
    let shortfallBani = 0;
    for (const item of order.items || []) {
      const ordered = Number(item.quantity || 0);
      const delivered = Number(quantities[item.id]);
      if (!Number.isFinite(delivered) || delivered >= ordered) {
        continue;
      }
      const missing = ordered - delivered;
      if (missing <= ordered * TOLERANCE) {
        continue;
      }
      const lineBani = Math.round(Number(item.lineTotal || 0) * 100);
      shortfallBani += ordered > 0 ? Math.round((lineBani * missing) / ordered) : 0;
    }
    return { shortfallBani };
  }, [order.items, quantities]);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setStatus({ state: 'loading', message: '' });
    try {
      const response = await apiFetch(`/api/orders/${order.id}/fulfilment`, {
        method: 'POST',
        body: JSON.stringify({
          fulfilled: Object.fromEntries(
            Object.entries(quantities).map(([id, value]) => [id, Number(value)]),
          ),
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Could not record the delivery.');
      }

      setStatus({
        state: 'success',
        message:
          data.fulfilment.shortfallBani > 0
            ? `Recorded. ${formatBani(data.fulfilment.shortfallBani)} has been refunded to the customer for what was short.`
            : 'Recorded as delivered in full.',
      });
      setOpen(false);
      onRecorded?.(data);
    } catch (error) {
      setStatus({ state: 'error', message: error.message });
    }
  };

  const canRecord = ['preparing_order', 'in_transit', 'arrived'].includes(order.orderState);
  if (!canRecord) {
    return null;
  }

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
          Record what was delivered
        </button>
      ) : (
        <form className="order-dispute-form" onSubmit={handleSubmit}>
          <p className="muted order-dispute-hint">
            Enter what actually went in the box. Small differences (up to 10%) are normal and cost
            you nothing — anything more is refunded to the customer automatically.
          </p>

          <ul className="fulfilment-lines">
            {(order.items || []).map((item) => (
              <li key={item.id}>
                <span className="fulfilment-line-name">
                  {item.productName}
                  <span className="muted"> · ordered {item.quantity} {item.productUnit}</span>
                </span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={quantities[item.id] ?? ''}
                  onChange={(event) =>
                    setQuantities((prev) => ({ ...prev, [item.id]: event.target.value }))
                  }
                />
              </li>
            ))}
          </ul>

          {preview.shortfallBani > 0 && (
            <p className="notice warn" role="status">
              {formatBani(preview.shortfallBani)} will be refunded to the customer and taken back
              from your payout.
            </p>
          )}

          <div className="order-dispute-actions">
            <button className="button quiet small" type="button" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button className="button primary small" type="submit" disabled={status.state === 'loading'}>
              {status.state === 'loading' ? 'Saving...' : 'Confirm'}
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
