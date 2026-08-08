import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { apiFetch } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useLiveUpdates, LIVE_TOPICS } from '../lib/liveUpdates.js';

const STATE_LABELS = {
  received_by_farmer: 'Accepted',
  preparing_order: 'Being prepared',
  in_transit: 'On the way',
  arrived: 'Arrived',
  received: 'Delivered',
};

/** Where each order's money currently is, in the farmer's own terms. */
const TRANSFER_LABELS = {
  none: 'Processing',
  // The customer has paid; the platform holds your share until they confirm
  // the order arrived. This is the state most open orders sit in.
  held: 'Held until delivery',
  pending: 'Transferring',
  sent: 'Transferred',
  failed: 'Transfer failed',
  reversed: 'Returned to customer',
  manual_required: 'Needs review',
};

const amountFormatter = new Intl.NumberFormat('en-GB', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Amounts arrive from the API as integer bani. Divide only for display. */
const formatBani = (bani) => {
  const amount = Number.isFinite(Number(bani)) ? Number(bani) : 0;
  return `${amountFormatter.format(amount / 100)} RON`;
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
  const maxTotal = months.reduce((max, entry) => Math.max(max, Number(entry.totalBani) || 0), 0);

  return (
    <ol className="earnings-chart" aria-label="Earnings over recent months">
      {months.map((entry) => {
        const total = Number(entry.totalBani) || 0;
        const fill = maxTotal > 0 ? Math.max(total > 0 ? 6 : 2, (total / maxTotal) * 100) : 2;
        // The filled part is money already in the farmer's Stripe account.
        const transferredShare = total > 0 ? (Number(entry.transferredBani) / total) * 100 : 0;

        return (
          <li
            className={`earnings-chart-col ${entry.month === currentMonth ? 'is-current' : ''}`}
            key={entry.month}
          >
            <span className="earnings-chart-value">{compactAmount(total / 100)}</span>
            <span className="earnings-chart-track">
              <span
                className="earnings-chart-bar"
                style={{ height: `${fill}%` }}
                title={`${entry.label}: ${formatBani(total)}`}
              >
                <span
                  className="earnings-chart-bar-cleared"
                  style={{ height: `${transferredShare}%` }}
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

    };

    subscribeRealtime().catch(() => {});

    return () => {
      active = false;
    };
  }, [authStatus, isVendor, user?.id, loadEarnings]);

  // SEC-01 — earnings follow order changes, over the server stream.
  useLiveUpdates(
    [LIVE_TOPICS.ORDERS],
    () => {
      loadEarnings().catch(() => {});
    },
    authStatus === 'authenticated' && isVendor,
  );

  const summary = data?.summary;
  const payouts = data?.payouts;
  const hasEarnings = Boolean(summary && summary.orderCount > 0);

  /** One-time link into the farmer's hosted Stripe dashboard. */
  const [dashboardState, setDashboardState] = useState({ state: 'idle', message: '' });

  const openStripeDashboard = async () => {
    setDashboardState({ state: 'loading', message: '' });
    try {
      const response = await apiFetch('/api/connect/dashboard', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || 'Stripe did not respond.');
      }
      window.location.href = payload.url;
    } catch (error) {
      setDashboardState({ state: 'error', message: error.message || 'Stripe did not respond.' });
    }
  };

  if (authStatus === 'loading') {
    return <div className="notice">Loading...</div>;
  }

  if (!user) {
    return (
      <div className="page-section">
        <h1>Earnings</h1>
        <p className="muted">Log in with your farm account to see what you have earned.</p>
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
        <p className="muted">This page is available for farm accounts only.</p>
      </div>
    );
  }

  return (
    <div className="page-section">
      <div className="section-header">
        <div>
          <h1>Earnings</h1>
          <p className="muted">
            Money reaches your Stripe account right after each paid order. From there, Stripe
            sends it on to your bank.
          </p>
        </div>
        <div className="button-group">
          {payouts?.connected && payouts?.detailsSubmitted && (
            <button
              type="button"
              className="button primary"
              onClick={openStripeDashboard}
              disabled={dashboardState.state === 'loading'}
            >
              {dashboardState.state === 'loading' ? 'Opening...' : 'My Stripe dashboard'}
            </button>
          )}
          <Link className="button ghost" to="/orders">
            View orders
          </Link>
        </div>
      </div>

      {loadStatus.state === 'loading' && <p className="notice">Loading...</p>}
      {loadStatus.state === 'error' && (
        <p className="notice error" role="alert">
          {loadStatus.message}
        </p>
      )}
      {dashboardState.state === 'error' && (
        <p className="notice error" role="alert">
          {dashboardState.message}
        </p>
      )}

      {data && payouts && !payouts.canSell && (
        <p className="notice error" role="alert">
          Your payout account is not active yet, so your products do not appear in the shop.{' '}
          <Link className="earnings-inline-link" to="/profile">
            Set up payouts
          </Link>
        </p>
      )}

      {data && !data.profileApproved && (
        <p className="orders-hint">
          Your farm is not approved yet. Earnings start counting as soon as customers pay.
        </p>
      )}

      {data && summary && (
        <>
          <section className="earnings-hero">
            <div className="earnings-hero-main">
              <p className="earnings-hero-label">Collected in {summary.label}</p>
              <p className="earnings-hero-amount">{formatBani(summary.totalBani)}</p>
              <p className="earnings-hero-note">
                {summary.orderCount > 0
                  ? `${summary.orderCount} paid ${summary.orderCount === 1 ? 'order' : 'orders'}`
                  : 'No paid orders yet'}
                {payouts?.accountId ? ` · account ${payouts.accountId.slice(-6)}` : ''}
              </p>
            </div>
            <ul className="earnings-hero-split">
              <li>
                <span className="earnings-split-label">Transferred</span>
                <span className="earnings-split-value">{formatBani(summary.transferredBani)}</span>
                <span className="earnings-split-note">already in your Stripe account</span>
              </li>
              <li>
                <span className="earnings-split-label">Held</span>
                <span className="earnings-split-value">{formatBani(summary.inTransitBani)}</span>
                <span className="earnings-split-note">released when the customer confirms</span>
              </li>
            </ul>
          </section>

          {summary.failedBani > 0 && (
            <p className="notice error" role="alert">
              {formatBani(summary.failedBani)} could not be transferred automatically. The team
              has been notified and is fixing it manually — the money is still owed to you in full.
            </p>
          )}

          <div className="earnings-stats">
            <div className="earnings-stat">
              <p className="earnings-stat-label">Paid orders</p>
              <p className="earnings-stat-value">{summary.orderCount}</p>
              <p className="earnings-stat-note">this month</p>
            </div>
            <div className="earnings-stat">
              <p className="earnings-stat-label">Customers</p>
              <p className="earnings-stat-value">{summary.customerCount}</p>
              <p className="earnings-stat-note">bought from you</p>
            </div>
            <div className="earnings-stat">
              <p className="earnings-stat-label">Average order</p>
              <p className="earnings-stat-value">{formatBani(summary.averageOrderBani)}</p>
              <p className="earnings-stat-note">per basket</p>
            </div>
            <div className="earnings-stat">
              <p className="earnings-stat-label">Last 12 months</p>
              <p className="earnings-stat-value">{formatBani(data.window?.totalBani)}</p>
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
                    Transferred
                  </span>
                  <span className="earnings-legend-item">
                    <span className="earnings-legend-swatch is-pending" aria-hidden="true" />
                    Held
                  </span>
                </span>
              </header>
              <div className="earnings-card-body">
                <EarningsChart months={data.months || []} currentMonth={summary.month} />
              </div>
            </section>

            <section className="earnings-card">
              <header className="earnings-card-head">
                <h2>Best sellers</h2>
                <span className="earnings-card-sub">{summary.label}</span>
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
                        <span className="earnings-product-total">
                          {formatBani(product.totalBani)}
                        </span>
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
              <span className="earnings-card-sub">{summary.label}</span>
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
                        {/* Where this money actually is, with the Stripe
                            reference the farmer can match in their dashboard. */}
                        <p className="earnings-order-transfer">
                          {TRANSFER_LABELS[order.transferState] || order.transferState}
                          {order.stripeTransferId ? ` · ${order.stripeTransferId}` : ''}
                        </p>
                      </div>
                      <div className="earnings-order-meta">
                        <span className={`order-state order-state-${order.orderState}`}>
                          {STATE_LABELS[order.orderState] || order.orderState}
                        </span>
                        <span className="earnings-order-date">
                          {formatDate(order.paidAt)} · {order.itemCount}{' '}
                          {order.itemCount === 1 ? 'item' : 'items'}
                        </span>
                        <span className="earnings-order-split">
                          Products {formatBani(order.productsSubtotalBani)}
                          {order.deliveryFeeBani > 0
                            ? ` · delivery ${formatBani(order.deliveryFeeBani)}`
                            : ''}
                        </span>
                      </div>
                      <span
                        className={`earnings-order-total ${
                          order.transferState === 'sent' ? 'is-cleared' : ''
                        }`}
                      >
                        {formatBani(order.amountBani)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="earnings-empty">
                  <p className="muted">
                    Nothing to show yet. As soon as a customer pays for an order, it lands here
                    with the amount you receive.
                  </p>
                  <Link className="button primary" to="/vendor/products_uploaded">
                    My products
                  </Link>
                </div>
              )}
            </div>
          </section>

          <p className="earnings-foot muted">
            There is no monthly payout any more. From every order you receive the products plus
            your delivery fee. We hold that amount from the moment the customer pays and transfer
            it to your Stripe account as soon as they confirm the order arrived — automatically
            after seven days if they forget. The platform fee is paid separately by the customer,
            on top of your prices.
          </p>
        </>
      )}
    </div>
  );
}
