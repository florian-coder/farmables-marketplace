import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { apiFetch } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useLiveUpdates, LIVE_TOPICS } from '../lib/liveUpdates.js';
import ReportProblem from '../components/ReportProblem.jsx';
import FulfilmentForm from '../components/FulfilmentForm.jsx';

const STATE_LABELS = {
  placed_order: 'In cart',
  pending_order: 'Awaiting payment',
  received_by_farmer: 'Accepted by farmer',
  preparing_order: 'Being prepared',
  in_transit: 'On the way',
  arrived: 'Arrived',
  received: 'Received',
  cancelled: 'Cancelled',
};

/** The journey an order takes, in order. Drives the timeline. */
const ORDER_JOURNEY = [
  { state: 'pending_order', label: 'Paid' },
  { state: 'received_by_farmer', label: 'Accepted' },
  { state: 'preparing_order', label: 'Prepared' },
  { state: 'in_transit', label: 'On the way' },
  { state: 'arrived', label: 'Arrived' },
  { state: 'received', label: 'Received' },
];

const CUSTOMER_TABS = [
  { id: 'cart', bucket: 'pending', label: 'Cart' },
  { id: 'unpaid', bucket: 'pending', label: 'Awaiting payment' },
  { id: 'active', bucket: 'active', label: 'In progress' },
  { id: 'history', bucket: 'history', label: 'History' },
];

const VENDOR_TABS = [
  { id: 'unpaid', bucket: 'pending', label: 'Incoming' },
  { id: 'active', bucket: 'active', label: 'In progress' },
  { id: 'history', bucket: 'history', label: 'History' },
];

const formatDateTime = (value) => {
  if (!value) {
    return '';
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return '';
  }
  return parsed.toLocaleString();
};

const formatMoney = (value) => {
  const amount = Number.isFinite(Number(value)) ? Number(value) : 0;
  return `${amount.toFixed(2)} RON`;
};

/** Amounts arrive from the API as integer bani. Never divide before here. */
const formatBani = (bani) => {
  const amount = Number.isFinite(Number(bani)) ? Number(bani) : 0;
  return `${(amount / 100).toFixed(2)} RON`;
};

const formatQuantity = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return '0';
  }
  return Number.isInteger(parsed) ? String(parsed) : parsed.toFixed(2).replace(/\.?0+$/, '');
};

/**
 * OPS-01b — what happened to the money after a cancellation.
 *
 * A cancelled order with no word about the refund is the single most alarming
 * thing a customer can be shown, so every cancelled-and-paid order says where
 * their money is, including the case where it needs a human.
 */
const RefundNotice = ({ order, isVendor }) => {
  const state = order.refundState || 'none';
  if (state === 'none' || !order.paidAt) {
    return null;
  }

  const amount = formatBani(order.refundedBani);
  const messages = {
    pending: {
      tone: 'info',
      text: isVendor
        ? 'The refund to the customer is being processed.'
        : 'Your refund is on its way. Card refunds usually appear within 5–10 business days.',
    },
    refunded: {
      tone: 'ok',
      text: isVendor
        ? `${amount} was refunded to the customer and taken back from your payout.`
        : `${amount} has been refunded to the card you paid with. It usually appears within 5–10 business days.`,
    },
    partial: {
      tone: 'ok',
      text: isVendor
        ? `${amount} was refunded to the customer for the missing items.`
        : `${amount} has been refunded for the missing items. It usually appears within 5–10 business days.`,
    },
    failed: {
      tone: 'warn',
      text: isVendor
        ? 'The refund to the customer could not be completed. Our team has been alerted.'
        : 'We could not complete your refund automatically. Our team has been alerted and will contact you.',
    },
    refund_pending_manual: {
      tone: 'ok',
      text: isVendor
        ? `${amount} was refunded to the customer. We could not take it back from your Stripe balance, so we will be in touch about recovering it.`
        : `${amount} has been refunded to the card you paid with. It usually appears within 5–10 business days.`,
    },
  };

  const notice = messages[state];
  if (!notice) {
    return null;
  }

  return (
    <p className={`order-refund-notice is-${notice.tone}`} role="status">
      {notice.text}
    </p>
  );
};

const OrderTimeline = ({ orderState }) => {
  if (orderState === 'cancelled' || orderState === 'placed_order') {
    return null;
  }
  const currentIndex = ORDER_JOURNEY.findIndex((step) => step.state === orderState);

  return (
    <ol className="order-timeline" aria-label="Order progress">
      {ORDER_JOURNEY.map((step, index) => {
        const state = index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'todo';
        return (
          <li className={`order-timeline-step is-${state}`} key={step.state}>
            <span className="order-timeline-dot" aria-hidden="true" />
            <span className="order-timeline-label">{step.label}</span>
          </li>
        );
      })}
    </ol>
  );
};

export default function OrdersPage() {
  const { status: authStatus, user } = useAuth();
  const isVendor = user?.role === 'vendor';
  const tabs = isVendor ? VENDOR_TABS : CUSTOMER_TABS;

  const [activeTab, setActiveTab] = useState(isVendor ? 'unpaid' : 'cart');
  const [orders, setOrders] = useState([]);
  const [loadStatus, setLoadStatus] = useState({ state: 'loading', message: '' });
  const [orderActionStatus, setOrderActionStatus] = useState({});
  const [replyDrafts, setReplyDrafts] = useState({});
  const [replyStatus, setReplyStatus] = useState({});
  const [openThreads, setOpenThreads] = useState({});
  const [stripeNotice, setStripeNotice] = useState(null);
  // The price breakdown for the whole cart, from the server. The cart must
  // never compute its own totals: the number shown here has to be the number
  // the card is charged.
  const [quote, setQuote] = useState(null);
  const [payStatus, setPayStatus] = useState({ state: 'idle', message: '' });
  // LEG-02 — consent at order placement. Deliberately not remembered between
  // orders: it is consent for *this* contract, and a pre-ticked box is not
  // consent at all.
  const [orderTerms, setOrderTerms] = useState(null);
  const [termsAccepted, setTermsAccepted] = useState(false);

  const isAllowedRole = user?.role === 'customer' || user?.role === 'vendor';
  const currentTab = tabs.find((tab) => tab.id === activeTab) || tabs[0];
  const bucket = currentTab.bucket;

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('success') === 'true') {
      setStripeNotice({
        state: 'success',
        message: 'Payment received. Your order is on its way to the farmer.',
      });
      setActiveTab('active');
      window.history.replaceState({}, '', window.location.pathname);
    } else if (params.get('canceled') === 'true') {
      setStripeNotice({ state: 'error', message: 'Payment was canceled. Your cart is untouched.' });
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  const setActionStatusForOrder = (orderId, state, message) => {
    if (!orderId) return;
    setOrderActionStatus((prev) => ({ ...prev, [orderId]: { state, message } }));
  };

  const setReplyStatusForOrder = (orderId, state, message) => {
    if (!orderId) return;
    setReplyStatus((prev) => ({ ...prev, [orderId]: { state, message } }));
  };

  const loadOrders = useCallback(async (nextBucket) => {
    setLoadStatus((prev) =>
      prev.state === 'success' ? prev : { state: 'loading', message: 'Loading orders...' },
    );
    try {
      const response = await apiFetch(`/api/orders?bucket=${nextBucket}`, { method: 'GET' });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Unable to load orders.');
      }
      setOrders(Array.isArray(data.orders) ? data.orders : []);
      setLoadStatus({ state: 'success', message: '' });
    } catch (error) {
      setOrders([]);
      setLoadStatus({ state: 'error', message: error.message || 'Unable to load orders.' });
    }
  }, []);

  /** Refresh the price breakdown. Customers only — vendors have no cart. */
  const loadQuote = useCallback(async () => {
    if (user?.role !== 'customer') {
      return;
    }
    try {
      const response = await apiFetch('/api/checkout/summary', { method: 'GET' });
      const data = await response.json();
      if (response.ok) {
        setQuote(data);
      }
    } catch (error) {
      // A failed quote leaves the previous breakdown on screen rather than
      // showing a total we are no longer sure of.
      console.error('Could not load the price breakdown:', error);
    }
  }, [user?.role]);

  /**
   * LEG-02 — which document has to be accepted when an order is placed.
   *
   * The backend registry is the authority on the version in force; the
   * Markdown in this repo only carries the text. Fetching it means a tab left
   * open across a terms update cannot tick a box for a version nobody is
   * showing any more.
   */
  const loadOrderTerms = useCallback(async () => {
    if (user?.role !== 'customer') {
      return;
    }
    try {
      const response = await apiFetch('/api/legal/documents', { method: 'GET' });
      const data = await response.json();
      if (!response.ok) {
        return;
      }
      const required = (data.documents || []).find(
        (doc) => doc.requiredAtOrder && (doc.audience === 'all' || doc.audience === 'customer'),
      );
      setOrderTerms(required || null);
    } catch (error) {
      // Leaving `orderTerms` null means the checkbox is not rendered and the
      // server is the one that refuses — which is the right place for the
      // decision anyway.
      console.error('Could not load the terms registry:', error);
    }
  }, [user?.role]);

  useEffect(() => {
    loadOrderTerms().catch(() => {});
  }, [loadOrderTerms]);

  useEffect(() => {
    if (authStatus !== 'authenticated' || !user || !isAllowedRole) {
      return undefined;
    }

    let active = true;
    const load = async () => {
      await loadOrders(bucket);
      if (!active) return;
      await loadQuote();
    };
    load().catch(() => {});

    return () => {
      active = false;
    };
  }, [authStatus, user, isAllowedRole, bucket, loadOrders, loadQuote]);

  // SEC-01 — one server-sent stream instead of two Supabase subscriptions.
  // The old `order_replies` channel had no filter at all, so every browser was
  // told about every reply on the platform.
  useLiveUpdates(
    [LIVE_TOPICS.ORDERS],
    () => {
      loadOrders(bucket).catch(() => {});
      loadQuote().catch(() => {});
    },
    authStatus === 'authenticated' && isAllowedRole,
  );

  /**
   * One payment for the whole cart, however many farms it contains.
   *
   * There is no order id to send any more: the server takes the cart to be
   * whatever `placed_order` rows belong to the authenticated customer.
   */
  const handlePayCart = async () => {
    // LEG-02 — consent belongs to *this contract*, not only to the account.
    // The version travels with it so the server can refuse a tab that has been
    // open since before the terms changed, rather than record consent to text
    // nobody is showing any more.
    if (orderTerms && !termsAccepted) {
      setPayStatus({
        state: 'error',
        message: 'Please accept the terms and conditions before placing the order.',
      });
      return;
    }

    setPayStatus({ state: 'loading', message: 'Opening secure checkout...' });
    try {
      const response = await apiFetch('/api/checkout/create-checkout-session', {
        method: 'POST',
        body: JSON.stringify({
          acceptedDocuments: orderTerms
            ? [{ key: orderTerms.key, version: orderTerms.version }]
            : [],
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        if (data.quote) {
          setQuote(data.quote);
        }
        if (response.status === 409 && data.code === 'terms_version_stale') {
          // The text changed while this tab was open. Reload the registry so
          // the checkbox refers to what is actually in force now.
          await loadOrderTerms();
          setTermsAccepted(false);
        }
        throw new Error(data.error || 'Could not start the payment.');
      }
      if (data.url) {
        window.location.href = data.url;
        return;
      }
      throw new Error('Stripe did not return a payment URL.');
    } catch (error) {
      setPayStatus({ state: 'error', message: error.message || 'Could not start the payment.' });
      await loadQuote();
    }
  };

  const handleOrderAction = async (orderId, nextState) => {
    if (!orderId || !nextState) return;

    setActionStatusForOrder(orderId, 'loading', 'Updating order...');
    try {
      const response = await apiFetch(`/api/orders/${orderId}/state`, {
        method: 'PATCH',
        body: JSON.stringify({ nextState }),
      });
      const data = await response.json();
      if (!response.ok) {
        // 409 means the order moved under us — someone else acted first, or
        // this tab has been open a while. Reloading is the fix, so we say so
        // and do it, rather than leaving a stale set of buttons on screen.
        if (response.status === 409) {
          setActionStatusForOrder(
            orderId,
            'error',
            `${data.error || 'This order has already changed.'} Refreshing...`,
          );
          await loadOrders(bucket);
          await loadQuote();
          return;
        }
        throw new Error(data.error || 'Unable to update order.');
      }

      // A cancellation that owed money says what happened to it.
      const refund = data.refund;
      const message = refund?.refunded
        ? `Order cancelled. ${formatBani(refund.breakdown?.amountBani || 0)} is on its way back to the customer.`
        : refund && refund.refunded === false && refund.reason !== 'already_claimed'
          ? 'Order cancelled, but the refund needs attention. Our team has been alerted.'
          : 'Order updated.';

      setActionStatusForOrder(orderId, refund && refund.refunded === false && refund.reason !== 'already_claimed' ? 'error' : 'success', message);
      await loadOrders(bucket);
      await loadQuote();
    } catch (error) {
      setActionStatusForOrder(orderId, 'error', error.message || 'Unable to update order.');
    }
  };

  /**
   * Payment status is checked per checkout now, not per order — the webhook
   * is the authority, this only covers the seconds between the redirect back
   * from Stripe and the webhook arriving.
   */
  const verifyPaymentStatus = async (order) => {
    const orderId = order.id;
    const checkoutId = order.checkoutId;
    if (!checkoutId) {
      setActionStatusForOrder(orderId, 'error', 'This order has no payment attached.');
      return;
    }

    setActionStatusForOrder(orderId, 'loading', 'Checking the payment...');
    try {
      const response = await apiFetch(`/api/checkout/${checkoutId}/status`, { method: 'GET' });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Verification failed.');
      }
      if (data.state === 'paid') {
        setActionStatusForOrder(orderId, 'success', 'Payment confirmed.');
        setActiveTab('active');
        await loadOrders('active');
      } else {
        setActionStatusForOrder(orderId, 'error', 'No payment found yet. Try again in a moment.');
      }
    } catch (error) {
      setActionStatusForOrder(orderId, 'error', error.message);
    }
  };

  const handleReplySubmit = async (event, orderId) => {
    event.preventDefault();
    const message = (replyDrafts[orderId] || '').trim();
    if (!message) return;

    setReplyStatusForOrder(orderId, 'loading', '');
    try {
      const response = await apiFetch(`/api/orders/${orderId}/replies`, {
        method: 'POST',
        body: JSON.stringify({ message }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Unable to send message.');
      }
      setReplyDrafts((prev) => ({ ...prev, [orderId]: '' }));
      setReplyStatusForOrder(orderId, 'idle', '');
      await loadOrders(bucket);
    } catch (error) {
      setReplyStatusForOrder(orderId, 'error', error.message || 'Unable to send message.');
    }
  };

  /** Quantity changes are only accepted by the API while the order is still a cart. */
  const handleItemQuantityChange = async (orderId, itemId, nextQuantity) => {
    setActionStatusForOrder(orderId, 'loading', 'Updating cart...');
    try {
      const response = await apiFetch(`/api/orders/${orderId}/items/${itemId}`, {
        method: 'PATCH',
        body: JSON.stringify({ quantity: nextQuantity }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Unable to update quantity.');
      }
      setActionStatusForOrder(orderId, 'idle', '');
      await loadOrders(bucket);
      // Quantities changed, so the fee breakdown did too.
      await loadQuote();
    } catch (error) {
      setActionStatusForOrder(orderId, 'error', error.message || 'Unable to update quantity.');
    }
  };

  const visibleOrders = useMemo(() => {
    if (activeTab === 'cart') {
      return orders.filter((order) => order.orderState === 'placed_order');
    }
    if (activeTab === 'unpaid') {
      return orders.filter((order) => order.orderState !== 'placed_order');
    }
    return orders;
  }, [orders, activeTab]);

  /** Per-farm breakdown, keyed by the cart order it belongs to. */
  const quoteByOrderId = useMemo(() => {
    const map = new Map();
    for (const group of quote?.groups || []) {
      map.set(group.orderId, group);
    }
    return map;
  }, [quote]);

  const emptyLabel = {
    cart: 'Your cart is empty. Browse the markets to add something fresh.',
    unpaid: isVendor ? 'No incoming orders right now.' : 'Nothing waiting for payment.',
    active: 'No orders in progress.',
    history: 'No completed orders yet.',
  }[activeTab];

  if (authStatus === 'loading') {
    return <div className="notice">Loading orders...</div>;
  }

  if (!user) {
    return (
      <div className="page-section">
        <h1>Orders</h1>
        <p className="muted">Log in to see your cart and track your orders.</p>
        <Link className="button primary" to="/auth/login">
          Log in
        </Link>
      </div>
    );
  }

  if (!isAllowedRole) {
    return (
      <div className="page-section">
        <h1>Orders unavailable</h1>
        <p className="muted">Orders are available for customer and farmer accounts only.</p>
      </div>
    );
  }

  return (
    <div className="page-section">
      <div className="section-header">
        <div>
          <h1>{isVendor ? 'Orders' : 'Your orders'}</h1>
          <p className="muted">
            {isVendor
              ? 'Track customer orders and move them along.'
              : 'Your cart, your payments and everything on its way.'}
          </p>
        </div>
      </div>

      <div className="orders-tabs" role="tablist" aria-label="Order groups">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            className={`orders-tab ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {stripeNotice && (
        <p
          className={`notice ${stripeNotice.state === 'error' ? 'error' : 'success'}`}
          role="status"
        >
          {stripeNotice.message}
          <button
            type="button"
            className="button quiet small notice-dismiss"
            onClick={() => setStripeNotice(null)}
          >
            Dismiss
          </button>
        </p>
      )}

      {activeTab === 'cart' && visibleOrders.length > 1 && (
        <p className="orders-hint">
          Your basket is split into {visibleOrders.length} orders, one per farm. Each farm
          packs and delivers separately, so each is paid separately.
        </p>
      )}

      {loadStatus.state === 'loading' && <p className="notice">Loading orders...</p>}
      {loadStatus.state === 'error' && (
        <p className="notice error" role="alert">
          {loadStatus.message}
        </p>
      )}

      {loadStatus.state === 'success' && visibleOrders.length === 0 && (
        <div className="orders-empty">
          <p className="muted">{emptyLabel}</p>
          {activeTab === 'cart' && (
            <Link className="button primary" to="/markets">
              Browse markets
            </Link>
          )}
        </div>
      )}

      <div className="orders-list">
        {visibleOrders.map((order) => {
          const isCart = order.orderState === 'placed_order';
          const isBusy = orderActionStatus[order.id]?.state === 'loading';
          const threadOpen = Boolean(openThreads[order.id]);
          const replyCount = order.replies?.length || 0;
          const groupQuote = quoteByOrderId.get(order.id) || null;

          return (
            <article className={`order-card ${isCart ? 'is-cart' : ''}`} key={order.id}>
              <header className="order-card-header">
                <div className="order-card-identity">
                  <p className="order-card-partner">
                    {order.partner?.title || (isVendor ? 'Customer' : 'Farm')}
                  </p>
                  <p className="order-card-ref">
                    {isCart ? 'Cart' : `Order #${order.id.slice(0, 8)}`}
                    {order.partner?.subtitle ? ` · ${order.partner.subtitle}` : ''}
                  </p>
                </div>
                <div className="order-card-headline">
                  <span className={`order-state order-state-${order.orderState}`}>
                    {STATE_LABELS[order.orderState] || order.orderState}
                  </span>
                  <span className="order-card-total">
                    {/* Once placed, the frozen per-farm total is what the
                        customer actually paid for this farm; before that it
                        is the live quote. `totalPrice` (products only) is the
                        fallback for orders from before the migration. */}
                    {isCart && groupQuote
                      ? formatBani(groupQuote.customerTotalBani)
                      : order.productsSubtotalBani > 0
                        ? formatBani(
                            order.productsSubtotalBani +
                              order.deliveryFeeBani +
                              order.commissionBani,
                          )
                        : formatMoney(order.totalPrice)}
                  </span>
                </div>
              </header>

              <OrderTimeline orderState={order.orderState} />

              {order.orderState === 'cancelled' && order.cancelReason && (
                <p className="order-cancel-reason">
                  Cancelled by the {order.cancelledBy === 'farmer' ? 'farm' : order.cancelledBy || 'platform'}:{' '}
                  {order.cancelReason}
                </p>
              )}
              <RefundNotice order={order} isVendor={isVendor} />

              <ul className="order-items">
                {order.items?.length > 0 ? (
                  order.items.map((item) => (
                    <li className="order-item" key={item.id}>
                      <div className="order-item-main">
                        <p className="order-item-name">{item.productName || 'Product'}</p>
                        <p className="order-item-unit">
                          {formatMoney(item.unitPrice)} / {item.productUnit || 'unit'}
                        </p>
                        {/* OPS-06 — `quantity` is what was ordered and paid
                            for; this is what arrived. Only shown when they
                            differ, so a full delivery stays quiet. */}
                        {item.fulfilledQuantity !== null &&
                          item.fulfilledQuantity !== undefined &&
                          item.fulfilledQuantity !== item.quantity && (
                            <p className="order-item-fulfilled">
                              Delivered: {formatQuantity(item.fulfilledQuantity)}{' '}
                              {item.productUnit || 'unit'} of {formatQuantity(item.quantity)}
                            </p>
                          )}
                      </div>

                      {isCart ? (
                        <div className="order-item-controls">
                          <div className="quantity-wrapper">
                            <button
                              className="quantity-btn"
                              type="button"
                              aria-label={`Decrease ${item.productName}`}
                              disabled={isBusy}
                              onClick={() =>
                                handleItemQuantityChange(
                                  order.id,
                                  item.id,
                                  Math.max(0, Number(item.quantity) - 1),
                                )
                              }
                            >
                              −
                            </button>
                            <span className="quantity-value" aria-live="polite">
                              {formatQuantity(item.quantity)}
                            </span>
                            <button
                              className="quantity-btn"
                              type="button"
                              aria-label={`Increase ${item.productName}`}
                              disabled={isBusy}
                              onClick={() =>
                                handleItemQuantityChange(
                                  order.id,
                                  item.id,
                                  Number(item.quantity) + 1,
                                )
                              }
                            >
                              +
                            </button>
                          </div>
                          <span className="order-item-total">{formatMoney(item.lineTotal)}</span>
                          <button
                            className="button quiet small"
                            type="button"
                            disabled={isBusy}
                            onClick={() => handleItemQuantityChange(order.id, item.id, 0)}
                          >
                            Remove
                          </button>
                        </div>
                      ) : (
                        <div className="order-item-controls">
                          <span className="order-item-qty">
                            {formatQuantity(item.quantity)} {item.productUnit || ''}
                          </span>
                          <span className="order-item-total">{formatMoney(item.lineTotal)}</span>
                        </div>
                      )}
                    </li>
                  ))
                ) : (
                  <li className="order-item">
                    <p className="muted">This order has no products.</p>
                  </li>
                )}
              </ul>

              {/* What this farm costs on its own, so the totals below are
                  traceable back to a farm rather than being one lump sum. */}
              {isCart && groupQuote && (
                <dl className="order-card-breakdown">
                  <div>
                    <dt>Products</dt>
                    <dd>{formatBani(groupQuote.productsSubtotalBani)}</dd>
                  </div>
                  <div>
                    <dt>Delivery</dt>
                    <dd>
                      {groupQuote.deliveryFeeWaived
                        ? 'Free'
                        : groupQuote.deliveryFeeBani > 0
                          ? formatBani(groupQuote.deliveryFeeBani)
                          : '—'}
                    </dd>
                  </div>
                  {groupQuote.minOrderValueBani > 0 && (
                    <div>
                      <dt>Minimum order</dt>
                      <dd>{formatBani(groupQuote.minOrderValueBani)}</dd>
                    </div>
                  )}
                  {groupQuote.freeDeliveryThresholdBani > 0 && !groupQuote.deliveryFeeWaived && (
                    <div>
                      <dt>Free delivery above</dt>
                      <dd>{formatBani(groupQuote.freeDeliveryThresholdBani)}</dd>
                    </div>
                  )}
                </dl>
              )}

              {isCart && groupQuote?.blocked && (
                <p className="notice error" role="alert">
                  {groupQuote.blocked.message}
                </p>
              )}

              <div className="order-card-foot">
                <div className="order-card-meta">
                  {isCart ? (
                    <span>Quantities can be changed until you pay.</span>
                  ) : (
                    <span>Updated {formatDateTime(order.updatedAt) || 'recently'}</span>
                  )}
                </div>

                <div className="order-actions">
                  {order.orderState === 'pending_order' && !isVendor && (
                    <button
                      className="button ghost small"
                      type="button"
                      onClick={() => verifyPaymentStatus(order)}
                      disabled={isBusy}
                    >
                      Check payment
                    </button>
                  )}
                  {order.allowedActions?.map((action) => (
                    <button
                      key={`${order.id}-${action.nextState}`}
                      type="button"
                      className={`button ${
                        action.nextState === 'cancelled' ? 'danger' : 'primary'
                      } small`}
                      onClick={() => handleOrderAction(order.id, action.nextState)}
                      disabled={isBusy}
                    >
                      {action.label}
                    </button>
                  ))}
                  {/* OPS-03 — the complaint form lives where the problem is.
                      A customer who has to go looking for it charges back
                      instead, which costs everyone more and tells us nothing. */}
                  {!isVendor && <ReportProblem order={order} />}
                  {/* OPS-06 — a farm with 3 of 5 kilos delivers the 3 and
                      records it, instead of declining the whole order. */}
                  {isVendor && (
                    <FulfilmentForm order={order} onRecorded={() => loadOrders(bucket)} />
                  )}
                </div>
              </div>

              {orderActionStatus[order.id]?.message && (
                <p
                  className={`notice ${
                    orderActionStatus[order.id].state === 'error' ? 'error' : 'success'
                  }`}
                  role={orderActionStatus[order.id].state === 'error' ? 'alert' : 'status'}
                >
                  {orderActionStatus[order.id].message}
                </p>
              )}

              <div className="order-thread">
                <button
                  className="order-thread-toggle"
                  type="button"
                  aria-expanded={threadOpen}
                  onClick={() =>
                    setOpenThreads((prev) => ({ ...prev, [order.id]: !prev[order.id] }))
                  }
                >
                  <span>
                    Messages
                    {replyCount > 0 && <span className="order-thread-count">{replyCount}</span>}
                  </span>
                  <span aria-hidden="true">{threadOpen ? '−' : '+'}</span>
                </button>

                {threadOpen && (
                  <div className="order-thread-body">
                    {replyCount > 0 ? (
                      <div className="order-replies-list">
                        {order.replies.map((reply) => (
                          <div
                            className={`order-reply-item ${reply.isOwn ? 'own' : ''}`}
                            key={reply.id}
                          >
                            <p className="order-reply-meta">
                              {reply.isOwn ? 'You' : reply.senderName} ·{' '}
                              {formatDateTime(reply.createdAt)}
                            </p>
                            <p>{reply.message}</p>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="muted">No messages on this order yet.</p>
                    )}

                    <form
                      className="order-reply-form"
                      onSubmit={(event) => handleReplySubmit(event, order.id)}
                    >
                      <label className="field">
                        <span className="visually-hidden">Message about this order</span>
                        <textarea
                          rows="2"
                          value={replyDrafts[order.id] || ''}
                          onChange={(event) =>
                            setReplyDrafts((prev) => ({ ...prev, [order.id]: event.target.value }))
                          }
                          placeholder="Write a message about this order..."
                          required
                        />
                      </label>
                      <button
                        type="submit"
                        className="button ghost small"
                        disabled={replyStatus[order.id]?.state === 'loading'}
                      >
                        {replyStatus[order.id]?.state === 'loading' ? 'Sending...' : 'Send'}
                      </button>
                      {replyStatus[order.id]?.state === 'error' && (
                        <p className="notice error" role="alert">
                          {replyStatus[order.id].message}
                        </p>
                      )}
                    </form>
                  </div>
                )}
              </div>
            </article>
          );
        })}
      </div>

      {/*
        The cart summary is the legally load-bearing part of this page: under
        OUG 34/2014 every component of the price has to be visible before the
        customer commits, and the button has to say that pressing it creates
        an obligation to pay. No cost appears for the first time on Stripe's
        page.
      */}
      {activeTab === 'cart' && visibleOrders.length > 0 && quote && (
        <aside className="cart-summary cart-summary-detailed">
          <h2 className="cart-summary-heading">Order summary</h2>

          <dl className="cart-summary-lines">
            <div className="cart-summary-line">
              <dt>Products</dt>
              <dd>{formatBani(quote.totals.productsSubtotalBani)}</dd>
            </div>

            {quote.groups
              .filter((group) => group.deliveryFeeBani > 0 || group.deliveryFeeWaived)
              .map((group) => (
                <div className="cart-summary-line is-sub" key={`delivery-${group.orderId}`}>
                  <dt>Delivery · {group.farmName}</dt>
                  <dd>
                    {group.deliveryFeeWaived ? (
                      <span className="cart-summary-free">Free</span>
                    ) : (
                      formatBani(group.deliveryFeeBani)
                    )}
                  </dd>
                </div>
              ))}

            <div className="cart-summary-line">
              <dt>
                Platform service fee ({quote.commissionPercentLabel})
                <span className="cart-summary-hint">
                  The Farmables fee, applied to products only.
                </span>
              </dt>
              <dd>{formatBani(quote.totals.commissionBani)}</dd>
            </div>

            <div className="cart-summary-line is-total">
              <dt>Total to pay</dt>
              <dd>{formatBani(quote.totals.customerTotalBani)}</dd>
            </div>
          </dl>

          {quote.blockers?.length > 0 && (
            <ul className="cart-summary-blockers">
              {quote.blockers.map((blocker, index) => (
                <li className="notice error" key={`${blocker.code}-${index}`} role="alert">
                  {blocker.message}
                </li>
              ))}
            </ul>
          )}

          {/* LEG-02 — accepting the terms is part of placing the order, not
              just part of having an account. Unticked every time: a pre-ticked
              box is not consent. */}
          {orderTerms && (
            <label className="cart-summary-consent">
              <input
                type="checkbox"
                checked={termsAccepted}
                onChange={(event) => setTermsAccepted(event.target.checked)}
              />
              <span>
                I have read and accept the{' '}
                <Link to="/legal/terms-customers" target="_blank" rel="noreferrer">
                  {orderTerms.title}
                </Link>{' '}
                (version {orderTerms.version}) and the{' '}
                <Link to="/legal/returns" target="_blank" rel="noreferrer">
                  refund policy
                </Link>
                . I understand that fresh food is exempt from the 14-day withdrawal right.
              </span>
            </label>
          )}

          {payStatus.state === 'error' && (
            <p className="notice error" role="alert">
              {payStatus.message}
            </p>
          )}

          <button
            type="button"
            className="button primary cart-summary-pay"
            disabled={
              !quote.payable ||
              payStatus.state === 'loading' ||
              Boolean(orderTerms && !termsAccepted)
            }
            onClick={handlePayCart}
          >
            {payStatus.state === 'loading'
              ? 'Opening checkout...'
              : 'Order with obligation to pay'}
          </button>

          <p className="cart-summary-note">
            One single payment for all {visibleOrders.length} farms in your basket. Each farm
            prepares and delivers its own part separately.
          </p>
        </aside>
      )}
    </div>
  );
}
