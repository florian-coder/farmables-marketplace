import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { apiFetch } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { supabase } from '../lib/supabase.js';

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
  return `${amount.toFixed(2).replace('.', ',')} lei`;
};

const formatQuantity = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return '0';
  }
  return Number.isInteger(parsed) ? String(parsed) : parsed.toFixed(2).replace(/\.?0+$/, '');
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

  useEffect(() => {
    if (authStatus !== 'authenticated' || !user || !isAllowedRole) {
      return undefined;
    }

    let active = true;
    let ordersChannel = null;
    let repliesChannel = null;

    const subscribeRealtime = async () => {
      await loadOrders(bucket);
      if (!active) return;

      const ordersFilter =
        user.role === 'customer' ? `client_id=eq.${user.id}` : `farmer_id=eq.${user.id}`;

      ordersChannel = supabase
        .channel(`orders-${user.role}-${user.id}-${bucket}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'orders', filter: ordersFilter },
          () => {
            loadOrders(bucket).catch(() => {});
          },
        )
        .subscribe();

      repliesChannel = supabase
        .channel(`order-replies-${user.role}-${user.id}-${bucket}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'order_replies' },
          () => {
            loadOrders(bucket).catch(() => {});
          },
        )
        .subscribe();
    };

    subscribeRealtime().catch(() => {});

    return () => {
      active = false;
      if (ordersChannel) supabase.removeChannel(ordersChannel);
      if (repliesChannel) supabase.removeChannel(repliesChannel);
    };
  }, [authStatus, user, isAllowedRole, bucket, loadOrders]);

  const handleOrderAction = async (orderId, nextState) => {
    if (!orderId || !nextState) return;

    if (user?.role === 'customer' && nextState === 'pending_order') {
      setActionStatusForOrder(orderId, 'loading', 'Opening secure checkout...');
      try {
        const response = await apiFetch('/api/checkout/create-checkout-session', {
          method: 'POST',
          body: JSON.stringify({ orderId }),
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || 'Unable to start checkout.');
        }
        if (data.url) {
          window.location.href = data.url;
        }
      } catch (error) {
        setActionStatusForOrder(orderId, 'error', error.message || 'Unable to start checkout.');
      }
      return;
    }

    setActionStatusForOrder(orderId, 'loading', 'Updating order...');
    try {
      const response = await apiFetch(`/api/orders/${orderId}/state`, {
        method: 'PATCH',
        body: JSON.stringify({ nextState }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Unable to update order.');
      }
      setActionStatusForOrder(orderId, 'success', 'Order updated.');
      await loadOrders(bucket);
    } catch (error) {
      setActionStatusForOrder(orderId, 'error', error.message || 'Unable to update order.');
    }
  };

  const verifyPaymentStatus = async (orderId) => {
    setActionStatusForOrder(orderId, 'loading', 'Checking payment...');
    try {
      const response = await apiFetch(`/api/checkout/verify-status/${orderId}`, { method: 'GET' });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Verification failed.');
      }
      if (data.status === 'paid') {
        setActionStatusForOrder(orderId, 'success', 'Payment confirmed.');
        setActiveTab('active');
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

  const cartTotal = useMemo(
    () =>
      activeTab === 'cart'
        ? visibleOrders.reduce((sum, order) => sum + Number(order.totalPrice || 0), 0)
        : 0,
    [visibleOrders, activeTab],
  );

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
                  <span className="order-card-total">{formatMoney(order.totalPrice)}</span>
                </div>
              </header>

              <OrderTimeline orderState={order.orderState} />

              <ul className="order-items">
                {order.items?.length > 0 ? (
                  order.items.map((item) => (
                    <li className="order-item" key={item.id}>
                      <div className="order-item-main">
                        <p className="order-item-name">{item.productName || 'Product'}</p>
                        <p className="order-item-unit">
                          {formatMoney(item.unitPrice)} / {item.productUnit || 'unit'}
                        </p>
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
                      onClick={() => verifyPaymentStatus(order.id)}
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

      {activeTab === 'cart' && visibleOrders.length > 0 && (
        <aside className="cart-summary">
          <div>
            <p className="cart-summary-label">Basket total</p>
            <p className="cart-summary-note">
              Across {visibleOrders.length} farm{visibleOrders.length === 1 ? '' : 's'} · paid
              separately
            </p>
          </div>
          <p className="cart-summary-total">{formatMoney(cartTotal)}</p>
        </aside>
      )}
    </div>
  );
}
