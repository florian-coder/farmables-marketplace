import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { apiFetch } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { supabase } from '../lib/supabase.js';

const ORDER_TABS = [
  { id: 'pending', label: 'Pending orders' },
  { id: 'active', label: 'Active orders' },
  { id: 'history', label: 'Order history' },
];

const STATE_LABELS = {
  placed_order: 'In cart',
  pending_order: 'Awaiting payment',
  received_by_farmer: 'Accepted by farmer',
  preparing_order: 'Preparing order',
  in_transit: 'In transit',
  arrived: 'Arrived',
  received: 'Received',
  cancelled: 'Cancelled',
};

const initialLoadStatus = {
  state: 'loading',
  message: '',
};

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
  const amount = Number(value);
  if (!Number.isFinite(amount)) {
    return '$0.00';
  }
  return `$${amount.toFixed(2)}`;
};

export default function OrdersPage() {
  const { status: authStatus, user } = useAuth();
  const [activeTab, setActiveTab] = useState('pending');
  const [orders, setOrders] = useState([]);
  const [loadStatus, setLoadStatus] = useState(initialLoadStatus);
  const [orderActionStatus, setOrderActionStatus] = useState({});
  const [replyDrafts, setReplyDrafts] = useState({});
  const [replyStatus, setReplyStatus] = useState({});
  const [stripeNotice, setStripeNotice] = useState(null);

  const isAllowedRole = user?.role === 'customer' || user?.role === 'vendor';

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('success') === 'true') {
      setStripeNotice({ state: 'success', message: 'Payment successful! Your order is now active.' });
      setActiveTab('active');
      // Clean up URL
      window.history.replaceState({}, '', window.location.pathname);
    } else if (params.get('canceled') === 'true') {
      setStripeNotice({ state: 'error', message: 'Payment was canceled.' });
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  const setActionStatusForOrder = (orderId, state, message) => {
    if (!orderId) {
      return;
    }
    setOrderActionStatus((prev) => ({
      ...prev,
      [orderId]: { state, message },
    }));
  };

  const setReplyStatusForOrder = (orderId, state, message) => {
    if (!orderId) {
      return;
    }
    setReplyStatus((prev) => ({
      ...prev,
      [orderId]: { state, message },
    }));
  };

  const loadOrders = useCallback(async (bucket) => {
    setLoadStatus((prev) =>
      prev.state === 'success'
        ? prev
        : { state: 'loading', message: 'Loading orders...' },
    );
    try {
      const response = await apiFetch(`/api/orders?bucket=${bucket}`, { method: 'GET' });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Unable to load orders.');
      }
      setOrders(Array.isArray(data.orders) ? data.orders : []);
      setLoadStatus({ state: 'success', message: '' });
    } catch (error) {
      setOrders([]);
      setLoadStatus({
        state: 'error',
        message: error.message || 'Unable to load orders.',
      });
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
      await loadOrders(activeTab);
      if (!active) {
        return;
      }

      const userId = user.id;
      const ordersFilter =
        user.role === 'customer'
          ? `client_id=eq.${userId}`
          : `farmer_id=eq.${userId}`;

      ordersChannel = supabase
        .channel(`orders-${user.role}-${userId}-${activeTab}`)
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'orders',
            filter: ordersFilter,
          },
          () => {
            loadOrders(activeTab).catch(() => {});
          },
        )
        .subscribe();

      repliesChannel = supabase
        .channel(`order-replies-${user.role}-${userId}-${activeTab}`)
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'order_replies',
          },
          () => {
            loadOrders(activeTab).catch(() => {});
          },
        )
        .subscribe();
    };

    subscribeRealtime().catch(() => {});

    return () => {
      active = false;
      if (ordersChannel) {
        supabase.removeChannel(ordersChannel);
      }
      if (repliesChannel) {
        supabase.removeChannel(repliesChannel);
      }
    };
  }, [authStatus, user, isAllowedRole, activeTab, loadOrders]);

  const handleOrderAction = async (orderId, nextState) => {
    if (!orderId || !nextState) {
      return;
    }

    if (user?.role === 'customer' && nextState === 'pending_order') {
      setActionStatusForOrder(orderId, 'loading', 'Redirecting to payment...');
      try {
        const response = await apiFetch('/api/checkout/create-checkout-session', {
          method: 'POST',
          body: JSON.stringify({ orderId }),
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || 'Unable to start checkout session.');
        }
        if (data.url) {
          window.location.href = data.url;
        }
      } catch (error) {
        setActionStatusForOrder(
          orderId,
          'error',
          error.message || 'Unable to start checkout.',
        );
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
        throw new Error(data.error || 'Unable to update order status.');
      }
      setActionStatusForOrder(orderId, 'success', 'Order status updated.');
      await loadOrders(activeTab);
    } catch (error) {
      setActionStatusForOrder(
        orderId,
        'error',
        error.message || 'Unable to update order status.',
      );
    }
  };

  const verifyPaymentStatus = async (orderId) => {
    setActionStatusForOrder(orderId, 'loading', 'Verifying payment status...');
    try {
      const response = await apiFetch(`/api/checkout/verify-status/${orderId}`, { method: 'GET' });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Verification failed.');
      }
      if (data.status === 'paid') {
        setActionStatusForOrder(orderId, 'success', 'Payment verified! Your order is now active.');
        setActiveTab('active');
        await loadOrders('active');
      } else {
        setActionStatusForOrder(orderId, 'error', 'Payment not found or still processing.');
      }
    } catch (error) {
      setActionStatusForOrder(orderId, 'error', error.message);
    }
  };

  const handleReplySubmit = async (event, orderId) => {
    event.preventDefault();
    const message = (replyDrafts[orderId] || '').trim();
    if (!message) {
      return;
    }

    setReplyStatusForOrder(orderId, 'loading', 'Sending reply...');
    try {
      const response = await apiFetch(`/api/orders/${orderId}/replies`, {
        method: 'POST',
        body: JSON.stringify({ message }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Unable to send order reply.');
      }
      setReplyDrafts((prev) => ({ ...prev, [orderId]: '' }));
      setReplyStatusForOrder(orderId, 'success', 'Reply sent.');
      await loadOrders(activeTab);
    } catch (error) {
      setReplyStatusForOrder(
        orderId,
        'error',
        error.message || 'Unable to send order reply.',
      );
    }
  };

  const handleItemQuantityChange = async (orderId, itemId, newQuantity) => {
    setActionStatusForOrder(orderId, 'loading', 'Updating quantity...');
    try {
      const response = await apiFetch(`/api/orders/${orderId}/items/${itemId}`, {
        method: 'PATCH',
        body: JSON.stringify({ quantity: newQuantity }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Unable to update item quantity.');
      }
      setActionStatusForOrder(orderId, 'success', 'Quantity updated.');
      await loadOrders(activeTab);
    } catch (error) {
      setActionStatusForOrder(
        orderId,
        'error',
        error.message || 'Unable to update item quantity.',
      );
    }
  };

  const emptyLabel = useMemo(() => {
    if (activeTab === 'history') {
      return 'No received orders yet.';
    }
    if (activeTab === 'active') {
      return 'No active orders right now.';
    }
    return 'No pending orders right now.';
  }, [activeTab]);

  if (authStatus === 'loading') {
    return <div className="notice">Loading orders...</div>;
  }

  if (!user) {
    return (
      <div className="page-section">
        <h1>Orders access required</h1>
        <p className="muted">Log in to view and manage your orders.</p>
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
        <p className="muted">Orders are available only for customer and vendor accounts.</p>
      </div>
    );
  }

  return (
    <div className="page-section">
      <div className="section-header">
        <div>
          <h1>Orders</h1>
          <p className="muted">
            {user.role === 'vendor'
              ? 'Track customer requests and update order status.'
              : 'Track your placed orders from farmers.'}
          </p>
        </div>
      </div>

      <div className="orders-tabs">
        {ORDER_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`button ${activeTab === tab.id ? 'secondary' : 'ghost'}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {stripeNotice && (
        <p className={`notice ${stripeNotice.state === 'error' ? 'error' : 'success'}`}>
          {stripeNotice.message}
          <button 
            type="button" 
            className="button ghost small" 
            style={{ marginLeft: '12px' }}
            onClick={() => setStripeNotice(null)}
          >
            Close
          </button>
        </p>
      )}

      {loadStatus.state === 'loading' && <p className="notice">Loading orders...</p>}
      {loadStatus.state === 'error' && <p className="notice error">{loadStatus.message}</p>}

      {loadStatus.state === 'success' && orders.length === 0 && (
        <p className="muted">{emptyLabel}</p>
      )}

      <div className="orders-list">
        {orders.map((order) => (
          <article className="form-card order-card" key={order.id}>
            <div className="order-card-header">
              <div>
                <h2>Order #{order.id.slice(0, 8)}</h2>
                <p className="muted">
                  {user.role === 'vendor' ? 'Client' : 'Farmer'}:{' '}
                  {order.partner?.title || 'N/A'}
                  {order.partner?.subtitle ? ` · ${order.partner.subtitle}` : ''}
                </p>
              </div>
              <div className="order-badge-group">
                <span className="badge">{STATE_LABELS[order.orderState] || order.orderState}</span>
                <span className="badge ghost">{formatMoney(order.totalPrice)}</span>
              </div>
            </div>

            <p className="muted">
              Created: {formatDateTime(order.createdAt) || 'N/A'} · Updated:{' '}
              {formatDateTime(order.updatedAt) || 'N/A'}
            </p>

            <div className="order-items">
              <p className="label">Products</p>
              {order.items?.length > 0 ? (
                <ul>
                  {order.items.map((item) => (
                    <li key={`${item.id}-${item.quantity}`}>
                      {order.orderState === 'placed_order' && user.role === 'customer' ? (
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                          <input
                            type="number"
                            min="0"
                            step="any"
                            defaultValue={item.quantity}
                            onBlur={(e) => {
                              const val = parseFloat(e.target.value);
                              if (!isNaN(val) && val !== item.quantity) {
                                handleItemQuantityChange(order.id, item.id, val);
                              } else {
                                e.target.value = item.quantity;
                              }
                            }}
                            style={{ width: '80px', padding: '4px' }}
                            disabled={orderActionStatus[order.id]?.state === 'loading'}
                          />
                          x {item.productName || 'Product'} ({item.productUnit || 'unit'}) ·{' '}
                          {formatMoney(item.unitPrice)} each · {formatMoney(item.lineTotal)}
                          <button
                            type="button"
                            className="button ghost small"
                            onClick={() => handleItemQuantityChange(order.id, item.id, 0)}
                            style={{ padding: '2px 8px', marginLeft: '12px' }}
                            disabled={orderActionStatus[order.id]?.state === 'loading'}
                          >
                            Remove
                          </button>
                        </div>
                      ) : (
                        <>{item.quantity} x {item.productName || 'Product'} ({item.productUnit || 'unit'}) ·{' '}
                        {formatMoney(item.unitPrice)} each · {formatMoney(item.lineTotal)}</>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">No products on this order.</p>
              )}
            </div>

            {order.allowedActions?.length > 0 && (
              <div className="order-actions">
                {order.orderState === 'pending_order' && user.role === 'customer' && (
                  <button
                    type="button"
                    className="button ghost small"
                    onClick={() => verifyPaymentStatus(order.id)}
                    disabled={orderActionStatus[order.id]?.state === 'loading'}
                    style={{ marginRight: '8px' }}
                  >
                    Check payment status
                  </button>
                )}
                {order.allowedActions.map((action) => (
                  <button
                    key={`${order.id}-${action.nextState}`}
                    type="button"
                    className="button secondary small"
                    onClick={() => handleOrderAction(order.id, action.nextState)}
                    disabled={orderActionStatus[order.id]?.state === 'loading'}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            )}

            {orderActionStatus[order.id]?.message && (
              <p
                className={`notice ${
                  orderActionStatus[order.id]?.state === 'error'
                    ? 'error'
                    : orderActionStatus[order.id]?.state === 'success'
                      ? 'success'
                      : ''
                }`}
              >
                {orderActionStatus[order.id].message}
              </p>
            )}

            <div className="order-replies">
              <p className="label">Order conversation</p>
              {order.replies?.length > 0 ? (
                <div className="order-replies-list">
                  {order.replies.map((reply) => (
                    <div
                      className={`order-reply-item ${reply.isOwn ? 'own' : ''}`}
                      key={reply.id}
                    >
                      <p className="order-reply-meta">
                        {reply.isOwn ? 'You' : reply.senderName} ·{' '}
                        {formatDateTime(reply.createdAt) || 'N/A'}
                      </p>
                      <p>{reply.message}</p>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="muted">No replies yet.</p>
              )}

              <form className="order-reply-form" onSubmit={(event) => handleReplySubmit(event, order.id)}>
                <label className="field">
                  Reply
                  <textarea
                    name={`order-reply-${order.id}`}
                    rows="2"
                    value={replyDrafts[order.id] || ''}
                    onChange={(event) =>
                      setReplyDrafts((prev) => ({
                        ...prev,
                        [order.id]: event.target.value,
                      }))
                    }
                    placeholder="Write a reply for this order..."
                    required
                  />
                </label>
                <button
                  type="submit"
                  className="button ghost small"
                  disabled={replyStatus[order.id]?.state === 'loading'}
                >
                  {replyStatus[order.id]?.state === 'loading' ? 'Sending...' : 'Send reply'}
                </button>
              </form>

              {replyStatus[order.id]?.message && (
                <p
                  className={`notice ${
                    replyStatus[order.id]?.state === 'error'
                      ? 'error'
                      : replyStatus[order.id]?.state === 'success'
                        ? 'success'
                        : ''
                  }`}
                >
                  {replyStatus[order.id].message}
                </p>
              )}
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
