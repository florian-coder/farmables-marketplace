import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { apiFetch } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { supabase } from '../lib/supabase.js';

const STATE_LABELS = {
  received_by_farmer: 'Acceptată',
  preparing_order: 'În pregătire',
  in_transit: 'În tranzit',
  arrived: 'A ajuns',
  received: 'Livrată',
};

/** Where each order's money currently is, in the farmer's own terms. */
const TRANSFER_LABELS = {
  none: 'În procesare',
  pending: 'Se transferă',
  sent: 'Transferat',
  failed: 'Transfer eșuat',
  reversed: 'Stornat',
  manual_required: 'Necesită verificare',
};

const amountFormatter = new Intl.NumberFormat('ro-RO', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Amounts arrive from the API as integer bani. Divide only for display. */
const formatBani = (bani) => {
  const amount = Number.isFinite(Number(bani)) ? Number(bani) : 0;
  return `${amountFormatter.format(amount / 100)} lei`;
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
    <ol className="earnings-chart" aria-label="Câștiguri în ultimele luni">
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
        throw new Error(payload.error || 'Stripe nu a răspuns.');
      }
      window.location.href = payload.url;
    } catch (error) {
      setDashboardState({ state: 'error', message: error.message || 'Stripe nu a răspuns.' });
    }
  };

  if (authStatus === 'loading') {
    return <div className="notice">Se încarcă...</div>;
  }

  if (!user) {
    return (
      <div className="page-section">
        <h1>Câștiguri</h1>
        <p className="muted">Autentifică-te cu contul de fermă ca să vezi ce ai încasat.</p>
        <Link className="button primary" to="/auth/login">
          Autentificare
        </Link>
      </div>
    );
  }

  if (!isVendor) {
    return (
      <div className="page-section">
        <h1>Câștiguri indisponibile</h1>
        <p className="muted">Pagina e disponibilă doar pentru conturile de fermă.</p>
      </div>
    );
  }

  return (
    <div className="page-section">
      <div className="section-header">
        <div>
          <h1>Câștiguri</h1>
          <p className="muted">
            Banii ajung în contul tău Stripe imediat după fiecare comandă plătită. De acolo,
            Stripe îi trimite mai departe în banca ta.
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
              {dashboardState.state === 'loading' ? 'Se deschide...' : 'Panoul meu Stripe'}
            </button>
          )}
          <Link className="button ghost" to="/orders">
            Vezi comenzile
          </Link>
        </div>
      </div>

      {loadStatus.state === 'loading' && <p className="notice">Se încarcă...</p>}
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
          Contul tău de plată nu e încă activ, deci produsele tale nu apar în magazin.{' '}
          <Link className="earnings-inline-link" to="/profile">
            Configurează plățile
          </Link>
        </p>
      )}

      {data && !data.profileApproved && (
        <p className="orders-hint">
          Ferma ta nu e încă aprobată. Câștigurile încep să se adune imediat ce clienții plătesc.
        </p>
      )}

      {data && summary && (
        <>
          <section className="earnings-hero">
            <div className="earnings-hero-main">
              <p className="earnings-hero-label">Încasat în {summary.label}</p>
              <p className="earnings-hero-amount">{formatBani(summary.totalBani)}</p>
              <p className="earnings-hero-note">
                {summary.orderCount > 0
                  ? `${summary.orderCount} ${summary.orderCount === 1 ? 'comandă plătită' : 'comenzi plătite'}`
                  : 'Nicio comandă plătită încă'}
                {payouts?.accountId ? ` · cont ${payouts.accountId.slice(-6)}` : ''}
              </p>
            </div>
            <ul className="earnings-hero-split">
              <li>
                <span className="earnings-split-label">Transferat</span>
                <span className="earnings-split-value">{formatBani(summary.transferredBani)}</span>
                <span className="earnings-split-note">deja în contul tău Stripe</span>
              </li>
              <li>
                <span className="earnings-split-label">În tranzit</span>
                <span className="earnings-split-value">{formatBani(summary.inTransitBani)}</span>
                <span className="earnings-split-note">se transferă în câteva momente</span>
              </li>
            </ul>
          </section>

          {summary.failedBani > 0 && (
            <p className="notice error" role="alert">
              {formatBani(summary.failedBani)} nu au putut fi transferate automat. Echipa a fost
              notificată și rezolvă manual — banii îți rămân datorați integral.
            </p>
          )}

          <div className="earnings-stats">
            <div className="earnings-stat">
              <p className="earnings-stat-label">Comenzi plătite</p>
              <p className="earnings-stat-value">{summary.orderCount}</p>
              <p className="earnings-stat-note">luna aceasta</p>
            </div>
            <div className="earnings-stat">
              <p className="earnings-stat-label">Clienți</p>
              <p className="earnings-stat-value">{summary.customerCount}</p>
              <p className="earnings-stat-note">au cumpărat de la tine</p>
            </div>
            <div className="earnings-stat">
              <p className="earnings-stat-label">Comandă medie</p>
              <p className="earnings-stat-value">{formatBani(summary.averageOrderBani)}</p>
              <p className="earnings-stat-note">per coș</p>
            </div>
            <div className="earnings-stat">
              <p className="earnings-stat-label">Ultimele 12 luni</p>
              <p className="earnings-stat-value">{formatBani(data.window?.totalBani)}</p>
              <p className="earnings-stat-note">{data.window?.orderCount || 0} comenzi</p>
            </div>
          </div>

          <div className="earnings-columns">
            <section className="earnings-card">
              <header className="earnings-card-head">
                <h2>Ultimele {data.months?.length || 0} luni</h2>
                <span className="earnings-legend">
                  <span className="earnings-legend-item">
                    <span className="earnings-legend-swatch is-cleared" aria-hidden="true" />
                    Transferat
                  </span>
                  <span className="earnings-legend-item">
                    <span className="earnings-legend-swatch is-pending" aria-hidden="true" />
                    În tranzit
                  </span>
                </span>
              </header>
              <div className="earnings-card-body">
                <EarningsChart months={data.months || []} currentMonth={summary.month} />
              </div>
            </section>

            <section className="earnings-card">
              <header className="earnings-card-head">
                <h2>Cele mai vândute</h2>
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
                  <p className="muted">Nimic vândut luna asta încă.</p>
                )}
              </div>
            </section>
          </div>

          <section className="earnings-card">
            <header className="earnings-card-head">
              <h2>Comenzi plătite</h2>
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
                          Comanda #{order.reference}
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
                          {order.itemCount === 1 ? 'produs' : 'produse'}
                        </span>
                        <span className="earnings-order-split">
                          Produse {formatBani(order.productsSubtotalBani)}
                          {order.deliveryFeeBani > 0
                            ? ` · livrare ${formatBani(order.deliveryFeeBani)}`
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
                    Nimic de arătat încă. Imediat ce un client plătește o comandă, apare aici cu
                    suma pe care o primești.
                  </p>
                  <Link className="button primary" to="/vendor/products_uploaded">
                    Produsele mele
                  </Link>
                </div>
              )}
            </div>
          </section>

          <p className="earnings-foot muted">
            Nu mai există plată lunară. Din fiecare comandă primești produsele plus taxa ta de
            livrare, transferate în contul tău Stripe în câteva secunde de la plată. Comisionul
            platformei e plătit separat de client, peste prețurile tale.
          </p>
        </>
      )}
    </div>
  );
}
