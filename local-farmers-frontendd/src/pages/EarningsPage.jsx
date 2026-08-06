import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { apiFetch } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { supabase } from '../lib/supabase.js';

const STATE_LABELS = {
  received_by_farmer: 'Accepted',
  preparing_order: 'Being prepared',
  in_transit: 'On the way',
  arrived: 'Arrived',
  received: 'Delivered',
};

const amountFormatter = new Intl.NumberFormat('ro-RO', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const formatMoney = (value) => {
  const amount = Number.isFinite(Number(value)) ? Number(value) : 0;
  return `${amountFormatter.format(amount)} lei`;
};

const formatDate = (value) => {
  if (!value) {
    return '';
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return '';
  }
  return parsed.toLocaleDateString();
};

/** payoutDate vine ca YYYY-MM-DD, deci îl citim ca zi în UTC. */
const formatPayoutDate = (value) => {
  if (!value) {
    return '';
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    return '';
  }
  return parsed.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
};

const formatQuantity = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return '0';
  }
  return Number.isInteger(parsed) ? String(parsed) : parsed.toFixed(2).replace(/\.?0+$/, '');
};

/** Sume rotunde pe grafic: 1.2k citește mai bine decât 1.240,00. */
const compactAmount = (value) => {
  const amount = Number(value) || 0;
  if (amount === 0) {
    return '—';
  }
  if (amount >= 1000) {
    return `${(amount / 1000).toFixed(1).replace('.', ',')}k`;
  }
  return String(Math.round(amount));
};

const EarningsChart = ({ months, currentMonth }) => {
  const maxTotal = months.reduce((max, entry) => Math.max(max, Number(entry.total) || 0), 0);

  return (
    <ol className="earnings-chart" aria-label="Earnings over the last months">
      {months.map((entry) => {
        const total = Number(entry.total) || 0;
        const fill = maxTotal > 0 ? Math.max(total > 0 ? 6 : 2, (total / maxTotal) * 100) : 2;
        const clearedShare = total > 0 ? (Number(entry.cleared) / total) * 100 : 0;

        return (
          <li
            className={`earnings-chart-col ${entry.month === currentMonth ? 'is-current' : ''}`}
            key={entry.month}
          >
            <span className="earnings-chart-value">{compactAmount(total)}</span>
            <span className="earnings-chart-track">
              <span
                className="earnings-chart-bar"
                style={{ height: `${fill}%` }}
                title={`${entry.label}: ${formatMoney(total)}`}
              >
                <span
                  className="earnings-chart-bar-cleared"
                  style={{ height: `${clearedShare}%` }}
                />
              </span>
            </span>
            <span className="earnings-chart-month">{entry.shortLabel}</span>
          </li>
        );
      })}
    </ol>
  );
};

export default function EarningsPage() {
  const { status: authStatus, user } = useAuth();
  const isVendor = user?.role === 'vendor';

  const [data, setData] = useState(null);
  const [loadStatus, setLoadStatus] = useState({ state: 'loading', message: '' });

  const loadEarnings = useCallback(async () => {
    try {
      const response = await apiFetch('/api/earnings', { method: 'GET' });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || 'Unable to load earnings.');
      }
      setData(payload);
      setLoadStatus({ state: 'success', message: '' });
    } catch (error) {
      setLoadStatus({ state: 'error', message: error.message || 'Unable to load earnings.' });
    }
  }, []);

  useEffect(() => {
    if (authStatus !== 'authenticated' || !isVendor || !user?.id) {
      return undefined;
    }

    let active = true;
    let channel = null;

    const subscribeRealtime = async () => {
      await loadEarnings();
      if (!active) {
        return;
      }

      channel = supabase
        .channel(`earnings-${user.id}`)
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'orders',
            filter: `farmer_id=eq.${user.id}`,
          },
          () => {
            loadEarnings().catch(() => {});
          },
        )
        .subscribe();
    };

    subscribeRealtime().catch(() => {});

    return () => {
      active = false;
      if (channel) {
        supabase.removeChannel(channel);
      }
    };
  }, [authStatus, isVendor, user?.id, loadEarnings]);

  const payout = data?.payout;
  const hasEarnings = Boolean(payout && payout.orderCount > 0);

  const daysUntilPayout = useMemo(() => {
    if (!payout?.payoutDate) {
      return null;
    }
    const target = new Date(`${payout.payoutDate}T23:59:59Z`);
    if (Number.isNaN(target.getTime())) {
      return null;
    }
    return Math.max(0, Math.ceil((target.getTime() - Date.now()) / 86400000));
  }, [payout?.payoutDate]);

  if (authStatus === 'loading') {
    return <div className="notice">Loading earnings...</div>;
  }

  if (!user) {
    return (
      <div className="page-section">
        <h1>Earnings</h1>
        <p className="muted">Log in with your farm account to see what you are owed.</p>
        <Link className="button primary" to="/auth/login">
          Log in
        </Link>
      </div>
    );
  }

  if (!isVendor) {
    return (
      <div className="page-section">
        <h1>Earnings unavailable</h1>
        <p className="muted">Earnings are available for farm accounts only.</p>
      </div>
    );
  }

  return (
    <div className="page-section">
      <div className="section-header">
        <div>
          <h1>Earnings</h1>
          <p className="muted">
            Everything your customers paid you this month, and the day it lands in your account.
          </p>
        </div>
        <div className="button-group">
          <Link className="button ghost" to="/orders">
            View orders
          </Link>
        </div>
      </div>

      {loadStatus.state === 'loading' && <p className="notice">Loading earnings...</p>}
      {loadStatus.state === 'error' && (
        <p className="notice error" role="alert">
          {loadStatus.message}
        </p>
      )}

      {data && !data.iban?.present && (
        <p className="notice error" role="alert">
          No IBAN on your farm profile yet — we have nowhere to send the money.{' '}
          <Link className="earnings-inline-link" to="/profile">
            Add your IBAN
          </Link>
        </p>
      )}

      {data && !data.profileApproved && (
        <p className="orders-hint">
          Your farm is not approved yet. Earnings start counting as soon as customers pay for your
          products.
        </p>
      )}

      {data && (
        <>
          <section className="earnings-hero">
            <div className="earnings-hero-main">
              <p className="earnings-hero-label">To be paid on {formatPayoutDate(payout.payoutDate)}</p>
              <p className="earnings-hero-amount">{formatMoney(payout.total)}</p>
              <p className="earnings-hero-note">
                {payout.orderCount > 0
                  ? `${payout.orderCount} paid order${payout.orderCount === 1 ? '' : 's'} in ${payout.label}`
                  : `No paid orders in ${payout.label} yet`}
                {data.iban?.present ? ` · ${data.iban.masked}` : ''}
                {daysUntilPayout !== null
                  ? ` · ${daysUntilPayout === 0 ? 'today' : `in ${daysUntilPayout} day${daysUntilPayout === 1 ? '' : 's'}`}`
                  : ''}
              </p>
            </div>
            <ul className="earnings-hero-split">
              <li>
                <span className="earnings-split-label">Delivered</span>
                <span className="earnings-split-value">{formatMoney(payout.cleared)}</span>
                <span className="earnings-split-note">confirmed by the customer</span>
              </li>
              <li>
                <span className="earnings-split-label">In progress</span>
                <span className="earnings-split-value">{formatMoney(payout.pending)}</span>
                <span className="earnings-split-note">paid, not delivered yet</span>
              </li>
            </ul>
          </section>

          <div className="earnings-stats">
            <div className="earnings-stat">
              <p className="earnings-stat-label">Paid orders</p>
              <p className="earnings-stat-value">{payout.orderCount}</p>
              <p className="earnings-stat-note">this month</p>
            </div>
            <div className="earnings-stat">
              <p className="earnings-stat-label">Customers</p>
              <p className="earnings-stat-value">{payout.customerCount}</p>
              <p className="earnings-stat-note">bought from you</p>
            </div>
            <div className="earnings-stat">
              <p className="earnings-stat-label">Average order</p>
              <p className="earnings-stat-value">{formatMoney(payout.averageOrder)}</p>
              <p className="earnings-stat-note">per basket</p>
            </div>
            <div className="earnings-stat">
              <p className="earnings-stat-label">Last 12 months</p>
              <p className="earnings-stat-value">{formatMoney(data.window?.total)}</p>
              <p className="earnings-stat-note">{data.window?.orderCount || 0} orders</p>
            </div>
          </div>

          <div className="earnings-columns">
            <section className="earnings-card">
              <header className="earnings-card-head">
                <h2>Last {data.months?.length || 0} months</h2>
                <span className="earnings-legend">
                  <span className="earnings-legend-item">
                    <span className="earnings-legend-swatch is-cleared" aria-hidden="true" />
                    Delivered
                  </span>
                  <span className="earnings-legend-item">
                    <span className="earnings-legend-swatch is-pending" aria-hidden="true" />
                    In progress
                  </span>
                </span>
              </header>
              <div className="earnings-card-body">
                <EarningsChart months={data.months || []} currentMonth={payout.month} />
              </div>
            </section>

            <section className="earnings-card">
              <header className="earnings-card-head">
                <h2>Best sellers</h2>
                <span className="earnings-card-sub">{payout.label}</span>
              </header>
              <div className="earnings-card-body">
                {data.topProducts?.length > 0 ? (
                  <ol className="earnings-products">
                    {data.topProducts.map((product) => (
                      <li className="earnings-product" key={product.name}>
                        <span className="earnings-product-name">{product.name}</span>
                        <span className="earnings-product-qty">
                          {formatQuantity(product.quantity)} {product.unit}
                        </span>
                        <span className="earnings-product-total">{formatMoney(product.total)}</span>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="muted">Nothing sold this month yet.</p>
                )}
              </div>
            </section>
          </div>

          <section className="earnings-card">
            <header className="earnings-card-head">
              <h2>Paid orders</h2>
              <span className="earnings-card-sub">{payout.label}</span>
            </header>
            <div className="earnings-card-body">
              {hasEarnings ? (
                <ul className="earnings-orders">
                  {data.orders.map((order) => (
                    <li className="earnings-order" key={order.id}>
                      <div className="earnings-order-identity">
                        <p className="earnings-order-customer">{order.customerName}</p>
                        <p className="earnings-order-ref">
                          Order #{order.reference}
                          {order.customerLocation ? ` · ${order.customerLocation}` : ''}
                        </p>
                      </div>
                      <div className="earnings-order-meta">
                        <span className={`order-state order-state-${order.orderState}`}>
                          {STATE_LABELS[order.orderState] || order.orderState}
                        </span>
                        <span className="earnings-order-date">
                          {formatDate(order.paidAt)} · {order.itemCount} item
                          {order.itemCount === 1 ? '' : 's'}
                        </span>
                      </div>
                      <span
                        className={`earnings-order-total ${order.cleared ? 'is-cleared' : ''}`}
                      >
                        {formatMoney(order.total)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="earnings-empty">
                  <p className="muted">
                    Nothing to show yet. As soon as a customer pays for an order, it lands here
                    with the amount you earned.
                  </p>
                  <Link className="button primary" to="/vendor/products_uploaded">
                    My products
                  </Link>
                </div>
              )}
            </div>
          </section>

          <p className="earnings-foot muted">
            Payouts are sent at the end of each month to the IBAN on your farm profile. Orders that
            are still on their way are included once the customer confirms delivery.
          </p>
        </>
      )}
    </div>
  );
}
