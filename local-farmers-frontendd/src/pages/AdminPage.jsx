import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';

import { apiFetch, resolveImageUrl } from '../lib/api.js';
import ConfirmDialog from '../components/ConfirmDialog.jsx';

const formatDateTime = (value) => {
  if (!value) {
    return 'N/A';
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return 'N/A';
  }
  return parsed.toLocaleString();
};

const formatText = (value) => {
  if (typeof value !== 'string') {
    return 'N/A';
  }
  const trimmed = value.trim();
  return trimmed || 'N/A';
};

const formatNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? String(parsed) : 'N/A';
};

const formatPrice = (value) => {
  const parsed = Number(value);
  return (Number.isFinite(parsed) ? parsed : 0).toFixed(2).replace('.', ',');
};

const normalizeInlineText = (value) => {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
};

const formatAddress = (payload) => {
  const streetAddress = normalizeInlineText(payload?.streetAddress);
  const streetNumber = normalizeInlineText(payload?.streetNumber);
  const city = normalizeInlineText(payload?.city);
  const county = normalizeInlineText(payload?.county);

  const street = [streetAddress, streetNumber].filter(Boolean).join(' ');
  const cityCounty = [city, county].filter(Boolean).join(', ');
  const parts = [street, cityCounty].filter(Boolean);
  return parts.length > 0 ? parts.join(' | ') : 'N/A';
};

export default function AdminPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const [sessionStatus, setSessionStatus] = useState('loading');
  const [adminUsername, setAdminUsername] = useState('');
  const [credentials, setCredentials] = useState({
    username: '',
    password: '',
  });
  const [requests, setRequests] = useState([]);
  const [requestsStatus, setRequestsStatus] = useState({
    state: 'idle',
    message: '',
  });
  const [loginStatus, setLoginStatus] = useState({
    state: 'idle',
    message: '',
  });
  const [actionStatus, setActionStatus] = useState({
    state: 'idle',
    message: '',
  });
  const [rejectionNotes, setRejectionNotes] = useState({});
  const [pendingAction, setPendingAction] = useState(null);
  const [expandedRequests, setExpandedRequests] = useState({});
  const [documentStatus, setDocumentStatus] = useState({});

  /**
   * Actele stau într-un bucket privat. Adresa se cere la click, e semnată de
   * backend, expiră în două minute și lasă urmă în jurnalul de audit — deci nu
   * se pune niciodată în HTML.
   */
  const openDocument = async (requestId, docKey) => {
    const key = `${requestId}:${docKey}`;
    setDocumentStatus((prev) => ({ ...prev, [key]: 'loading' }));
    try {
      const response = await apiFetch(
        `/api/admin/farmer-requests/${requestId}/documents/${docKey}`,
        { method: 'GET' },
      );
      const data = await response.json();
      if (!response.ok || !data.url) {
        throw new Error(data.error || 'Unable to open document.');
      }
      window.open(data.url, '_blank', 'noopener,noreferrer');
      setDocumentStatus((prev) => ({ ...prev, [key]: 'idle' }));
    } catch (error) {
      setDocumentStatus((prev) => ({ ...prev, [key]: 'idle' }));
      window.alert(error.message || 'Unable to open document.');
    }
  };
  const adminPath = location.pathname.startsWith('/manage-portal')
    ? location.pathname.slice('/manage-portal'.length).replace(/^\/+/, '')
    : '';
  const tabSegment = adminPath.split('/')[0] || '';
  const activeTab = tabSegment === 'approved' ? 'approved' : 'pending';

  const loadRequests = useCallback(async () => {
    setRequestsStatus({ state: 'loading', message: '' });
    try {
      const response = await apiFetch('/api/admin/farmer-requests', { method: 'GET' });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Unable to load farmer requests.');
      }
      setRequests(Array.isArray(data.requests) ? data.requests : []);
      setRequestsStatus({ state: 'success', message: '' });
    } catch (error) {
      setRequestsStatus({
        state: 'error',
        message: error.message || 'Unable to load farmer requests.',
      });
    }
  }, []);

  useEffect(() => {
    let active = true;
    const loadSession = async () => {
      try {
        const response = await apiFetch('/api/admin/session', { method: 'GET' });
        if (!active) {
          return;
        }
        if (!response.ok) {
          setSessionStatus('guest');
          return;
        }

        const data = await response.json();
        setAdminUsername(data.username || 'admin');
        setSessionStatus('authenticated');
      } catch {
        if (active) {
          setSessionStatus('guest');
        }
      }
    };

    loadSession().catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (sessionStatus !== 'authenticated') {
      return;
    }
    loadRequests().catch(() => {});
  }, [sessionStatus, loadRequests]);

  useEffect(() => {
    if (sessionStatus !== 'authenticated') {
      return;
    }
    const isValidTab = tabSegment === 'pending' || tabSegment === 'approved';
    if (!isValidTab) {
      navigate('/manage-portal/pending', { replace: true });
    }
  }, [sessionStatus, tabSegment, navigate]);

  const handleLogin = async (event) => {
    event.preventDefault();
    setLoginStatus({ state: 'loading', message: 'Signing in...' });

    try {
      const response = await apiFetch('/api/admin/login', {
        method: 'POST',
        body: JSON.stringify(credentials),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Invalid admin credentials.');
      }

      setAdminUsername(data.username || credentials.username || 'admin');
      setCredentials({ username: '', password: '' });
      setLoginStatus({ state: 'success', message: '' });
      setSessionStatus('authenticated');
    } catch (error) {
      setLoginStatus({
        state: 'error',
        message: error.message || 'Login failed.',
      });
    }
  };

  const handleLogout = async () => {
    try {
      await apiFetch('/api/admin/logout', { method: 'POST' });
    } catch {
      // Ignore logout API errors and clear local UI anyway.
    }
    setRequests([]);
    setSessionStatus('guest');
    setAdminUsername('');
    setActionStatus({ state: 'idle', message: '' });
  };

  const handleApprove = async (requestId) => {
    if (!requestId) {
      return;
    }

    setActionStatus({ state: 'loading', message: 'Approving request...' });
    try {
      const response = await apiFetch(`/api/admin/farmer-requests/${requestId}/approve`, {
        method: 'POST',
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Unable to approve request.');
      }
      setActionStatus({ state: 'success', message: 'Request approved.' });
      await loadRequests();
    } catch (error) {
      setActionStatus({
        state: 'error',
        message: error.message || 'Unable to approve request.',
      });
    }
  };

  const handleReject = async (requestId) => {
    if (!requestId) {
      return;
    }

    const reviewNote =
      typeof rejectionNotes[requestId] === 'string'
        ? rejectionNotes[requestId].trim().slice(0, 1000)
        : '';
    if (!reviewNote) {
      setActionStatus({
        state: 'error',
        message: 'Rejection note is required before rejecting.',
      });
      return;
    }

    setActionStatus({ state: 'loading', message: 'Rejecting request...' });
    try {
      const response = await apiFetch(`/api/admin/farmer-requests/${requestId}/reject`, {
        method: 'POST',
        body: JSON.stringify({ reviewNote }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Unable to reject request.');
      }
      setActionStatus({ state: 'success', message: 'Request rejected.' });
      setRejectionNotes((prev) => {
        const next = { ...prev };
        delete next[requestId];
        return next;
      });
      await loadRequests();
    } catch (error) {
      setActionStatus({
        state: 'error',
        message: error.message || 'Unable to reject request.',
      });
    }
  };

  const handleUpdatePermissions = async (requestId, permissions) => {
    if (!requestId) return;
    setActionStatus({ state: 'loading', message: 'Updating permissions...' });
    try {
      const response = await apiFetch(`/api/admin/farmer-requests/${requestId}/permissions`, {
        method: 'PATCH',
        body: JSON.stringify(permissions),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Unable to update permissions.');
      }
      setActionStatus({ state: 'success', message: 'Permissions updated.' });
      await loadRequests();
    } catch (error) {
      setActionStatus({
        state: 'error',
        message: error.message || 'Unable to update permissions.',
      });
    }
  };

  const handleDeleteFarm = async (requestId) => {
    if (!requestId) {
      return;
    }

    setPendingAction(null);
    setActionStatus({ state: 'loading', message: 'Deleting farm and products...' });
    try {
      const response = await apiFetch(`/api/admin/farmer-requests/${requestId}/farm`, {
        method: 'DELETE',
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Unable to delete farm.');
      }
      const deletedProductsCount = Number(data?.deleted?.products) || 0;
      setActionStatus({
        state: 'success',
        message: `Farm deleted. Removed ${deletedProductsCount} product(s).`,
      });
      await loadRequests();
    } catch (error) {
      setActionStatus({
        state: 'error',
        message: error.message || 'Unable to delete farm.',
      });
    }
  };

  const handleDeleteProduct = async (productId) => {
    if (!productId) {
      return;
    }

    setPendingAction(null);
    setActionStatus({ state: 'loading', message: 'Deleting product...' });
    try {
      const response = await apiFetch(`/api/admin/products/${productId}`, {
        method: 'DELETE',
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Unable to delete product.');
      }
      const deletedProductName = formatText(data?.product?.name);
      setActionStatus({
        state: 'success',
        message: `Product deleted: ${deletedProductName}.`,
      });
      await loadRequests();
    } catch (error) {
      setActionStatus({
        state: 'error',
        message: error.message || 'Unable to delete product.',
      });
    }
  };

  const updateRejectionNote = (requestId, value) => {
    setRejectionNotes((prev) => ({
      ...prev,
      [requestId]: value.slice(0, 1000),
    }));
  };

  const toggleRequestExpanded = (requestId) => {
    if (!requestId) {
      return;
    }
    setExpandedRequests((prev) => ({
      ...prev,
      [requestId]: !prev[requestId],
    }));
  };

  const pendingRequests = requests.filter((request) => request.status === 'pending');
  const approvedRequests = requests.filter((request) => request.status === 'approved');

  const renderRequestCard = (request, options = { withActions: false }) => {
    const isExpanded = Boolean(expandedRequests[request.id]);
    const requestProducts = Array.isArray(request.products) ? request.products : [];
    const showProductsBlock = Boolean(options.withProductActions) || requestProducts.length > 0;
    return (
      <article className="admin-request-card" key={request.id}>
        <header className="admin-request-top">
          <div className="admin-request-title-wrap">
            <h3 className="admin-request-title">{formatText(request.payload?.farmName)}</h3>
          </div>
          <button
            className="button ghost small"
            type="button"
            onClick={() => toggleRequestExpanded(request.id)}
          >
            {isExpanded ? 'Hide full' : 'Show full'}
          </button>
        </header>

        <div className="admin-request-summary">
          <p className="admin-request-summary-item">
            <strong>Phone:</strong> {formatText(request.payload?.phoneNumber)}
          </p>
          <p className="admin-request-summary-item">
            <strong>Address:</strong> {formatAddress(request.payload)}
          </p>
        </div>

        {!isExpanded ? null : (
          <>
            <p className="muted">
              User: {formatText(request.username)} ({formatText(request.userId)}) · Status:{' '}
              {formatText(request.status)}
            </p>

            <div className="admin-request-grid">
              <div className="admin-request-field">
                <p className="admin-request-label">Display Name</p>
                <p className="admin-request-value">{formatText(request.payload?.displayName)}</p>
              </div>
              <div className="admin-request-field">
                <p className="admin-request-label">Email</p>
                <p className="admin-request-value">{formatText(request.payload?.email)}</p>
              </div>
              <div className="admin-request-field">
                <p className="admin-request-label">Organic Certificate</p>
                <p className="admin-request-value">{formatText(request.payload?.organicCertificate)}</p>
              </div>
              <div className="admin-request-field">
                <p className="admin-request-label">Delivery Radius (km)</p>
                <p className="admin-request-value">{formatNumber(request.payload?.deliveryRadiusKm)}</p>
              </div>
              <div className="admin-request-field">
                <p className="admin-request-label">Created At</p>
                <p className="admin-request-value">{formatDateTime(request.createdAt)}</p>
              </div>
              <div className="admin-request-field">
                <p className="admin-request-label">Updated At</p>
                <p className="admin-request-value">{formatDateTime(request.updatedAt)}</p>
              </div>
              <div className="admin-request-field">
                <p className="admin-request-label">Reviewed At</p>
                <p className="admin-request-value">{formatDateTime(request.reviewedAt)}</p>
              </div>
              <div className="admin-request-field">
                <p className="admin-request-label">Reviewed By</p>
                <p className="admin-request-value">{formatText(request.reviewedBy)}</p>
              </div>
            </div>

            <div className="admin-request-field">
              <p className="admin-request-label">Bio</p>
              <p className="admin-request-value">{formatText(request.payload?.bio)}</p>
            </div>
            
            {request.payload?.documents && Object.keys(request.payload.documents).length > 0 && (
              <div className="admin-request-field">
                <p className="admin-request-label">Legal Details & Documents</p>
                <div style={{ display: 'grid', gap: '0.5rem', marginTop: '0.5rem' }}>
                  {Object.keys(request.payload.documents).map((docKey) => (
                    <div key={docKey} style={{ display: 'flex', alignItems: 'center', gap: '1rem', padding: '0.5rem', background: 'var(--surface-color)', border: '1px solid var(--border-color)', borderRadius: '4px' }}>
                      <strong style={{ minWidth: '200px' }}>{docKey}:</strong>
                      <button
                        type="button"
                        className="button ghost small"
                        disabled={documentStatus[`${request.id}:${docKey}`] === 'loading'}
                        onClick={() => openDocument(request.id, docKey)}
                      >
                        {documentStatus[`${request.id}:${docKey}`] === 'loading'
                          ? 'Opening...'
                          : 'View Document'}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="admin-request-field">
              <p className="admin-request-label">Farm Images</p>
              {Array.isArray(request.payload?.farmImages) && request.payload.farmImages.length > 0 ? (
                <div className="farm-gallery-grid">
                  {request.payload.farmImages.map((imageUrl, imageIndex) => (
                    <a
                      className="farm-gallery-thumb"
                      href={resolveImageUrl(imageUrl)}
                      key={`${request.id}-img-${imageIndex}`}
                      target="_blank"
                      rel="noreferrer"
                      title="Open full image"
                    >
                      <img
                        src={resolveImageUrl(imageUrl)}
                        alt={`Farm ${request.payload?.farmName || 'request'} image ${imageIndex + 1}`}
                      />
                    </a>
                  ))}
                </div>
              ) : (
                <p className="admin-request-value">N/A</p>
              )}
            </div>

            {(request.status === 'approved' || request.status === 'pending') && request.permissions && (
              <div className="admin-request-field" style={{ background: 'var(--surface-color)', padding: '1rem', borderRadius: '4px', border: '1px solid var(--border-color)' }}>
                <p className="admin-request-label" style={{ marginBottom: '0.5rem' }}>Selling Permissions</p>
                <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <input 
                      type="checkbox" 
                      checked={request.permissions.fruits_and_veggies} 
                      onChange={(e) => handleUpdatePermissions(request.id, { fruits_and_veggies: e.target.checked })}
                      disabled={actionStatus.state === 'loading'}
                    /> 
                    Fruits & Vegetables
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <input 
                      type="checkbox" 
                      checked={request.permissions.eggs} 
                      onChange={(e) => handleUpdatePermissions(request.id, { eggs: e.target.checked })}
                      disabled={actionStatus.state === 'loading'}
                    /> 
                    Eggs
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <input 
                      type="checkbox" 
                      checked={request.permissions.honey} 
                      onChange={(e) => handleUpdatePermissions(request.id, { honey: e.target.checked })}
                      disabled={actionStatus.state === 'loading'}
                    /> 
                    Honey
                  </label>
                </div>
              </div>
            )}

            {showProductsBlock && (
              <div className="admin-request-field">
                <p className="admin-request-label">Products</p>
                {requestProducts.length > 0 ? (
                  <div className="stack">
                    {requestProducts.map((product) => (
                      <div className="product-row" key={`${request.id}-${product.id}`}>
                        <div className="product-info">
                          {product.image?.url ? (
                            <span className="product-thumb">
                              <img src={product.image.url} alt={product.image.alt || product.name} />
                            </span>
                          ) : (
                            <span className="product-thumb">No img</span>
                          )}
                          <div className="product-details">
                            <p className="admin-request-value">{formatText(product.name)}</p>
                            <p className="muted">
                              {formatText(product.category)} · {formatText(product.unit)} ·{' '}
                              {formatPrice(product.price)} RON
                            </p>
                          </div>
                        </div>
                        {options.withProductActions && (
                          <div className="product-actions">
                            <button
                              className="button danger small"
                              type="button"
                              onClick={() =>
                                setPendingAction({
                                  kind: 'product',
                                  id: product.id,
                                  name: formatText(product.name),
                                })
                              }
                              disabled={actionStatus.state === 'loading'}
                            >
                              Delete product
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="admin-request-value">No products.</p>
                )}
              </div>
            )}

            {request.reviewNote && <p className="notice error" role="alert">Review note: {request.reviewNote}</p>}

            {options.withActions && (
              <>
                <label className="field">
                  Rejection note (required for reject)
                  <textarea
                    rows="3"
                    value={rejectionNotes[request.id] || ''}
                    onChange={(event) => updateRejectionNote(request.id, event.target.value)}
                    placeholder="Write clearly why this profile request is rejected."
                  />
                </label>
                <div className="admin-request-actions">
                  <button
                    className="button secondary"
                    type="button"
                    onClick={() => handleApprove(request.id)}
                    disabled={actionStatus.state === 'loading'}
                  >
                    Approve
                  </button>
                  <button
                    className="button danger"
                    type="button"
                    onClick={() => handleReject(request.id)}
                    disabled={actionStatus.state === 'loading'}
                  >
                    Reject
                  </button>
                </div>
              </>
            )}

            {options.withFarmDeleteAction && (
              <div className="admin-request-actions">
                <button
                  className="button danger"
                  type="button"
                  onClick={() =>
                    setPendingAction({
                      kind: 'farm',
                      id: request.id,
                      name: formatText(request.payload?.farmName),
                    })
                  }
                  disabled={actionStatus.state === 'loading'}
                >
                  Delete farm and all products
                </button>
              </div>
            )}
          </>
        )}
      </article>
    );
  };

  if (sessionStatus === 'loading') {
    return <div className="notice">Loading admin panel...</div>;
  }

  if (sessionStatus !== 'authenticated') {
    return (
      <div className="page-section admin-login-section">
        <div className="form-card admin-login-card">
          <h1>Admin login</h1>
          <p className="muted">
            Authenticate with admin credentials to review farmer profile requests.
          </p>
          <form className="stack" onSubmit={handleLogin}>
            <label className="field">
              Username
              <input
                type="text"
                value={credentials.username}
                onChange={(event) =>
                  setCredentials((prev) => ({ ...prev, username: event.target.value }))
                }
                required
              />
            </label>
            <label className="field">
              Password
              <input
                type="password"
                autoComplete="current-password"
                value={credentials.password}
                onChange={(event) =>
                  setCredentials((prev) => ({ ...prev, password: event.target.value }))
                }
                required
              />
            </label>
            <button className="button primary" type="submit" disabled={loginStatus.state === 'loading'}>
              {loginStatus.state === 'loading' ? 'Signing in...' : 'Login'}
            </button>
            {loginStatus.state === 'error' && <p className="notice error" role="alert">{loginStatus.message}</p>}
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="page-section">
      <div className="section-header">
        <div>
          <h1>Admin panel</h1>
          <p className="muted">Signed in as {adminUsername}.</p>
        </div>
        <div className="button-group">
          <button className="button ghost" type="button" onClick={() => loadRequests()}>
            Refresh
          </button>
          <button className="button ghost" type="button" onClick={handleLogout}>
            Logout
          </button>
        </div>
      </div>

      {actionStatus.message && (
        <p className={`notice ${actionStatus.state === 'error' ? 'error' : 'success'}`} role="status">
          {actionStatus.message}
        </p>
      )}

      <div className="button-group">
        <Link
          className={`button ${activeTab === 'pending' ? 'secondary' : 'ghost'}`}
          to="/manage-portal/pending"
        >
          Pending requests
        </Link>
        <Link
          className={`button ${activeTab === 'approved' ? 'secondary' : 'ghost'}`}
          to="/manage-portal/approved"
        >
          Approved requests
        </Link>
      </div>

      <div className="form-card">
        <h2>{activeTab === 'pending' ? 'Pending requests' : 'Approved requests'}</h2>
        {requestsStatus.state === 'loading' && <p className="muted">Loading requests...</p>}
        {requestsStatus.state === 'error' && <p className="notice error" role="alert">{requestsStatus.message}</p>}

        {activeTab === 'pending' &&
          (pendingRequests.length === 0 && requestsStatus.state === 'success' ? (
            <p className="muted">No pending requests.</p>
          ) : (
            <div className="stack">
              {pendingRequests.map((request) => renderRequestCard(request, { withActions: true }))}
            </div>
          ))}

        {activeTab === 'approved' &&
          (approvedRequests.length === 0 && requestsStatus.state === 'success' ? (
            <p className="muted">No approved requests yet.</p>
          ) : (
            <div className="stack">
              {approvedRequests.map((request) =>
                renderRequestCard(request, {
                  withProductActions: true,
                  withFarmDeleteAction: true,
                }),
              )}
            </div>
          ))}
      </div>

      <ConfirmDialog
        open={Boolean(pendingAction)}
        title={
          pendingAction?.kind === 'farm' ? 'Delete this farm?' : 'Delete this product?'
        }
        body={
          pendingAction?.kind === 'farm'
            ? `The farm "${pendingAction?.name}" and all of its products will be permanently removed. This cannot be undone.`
            : `"${pendingAction?.name}" will be removed from the catalogue. This cannot be undone.`
        }
        confirmLabel={
          pendingAction?.kind === 'farm' ? 'Delete farm' : 'Delete product'
        }
        busy={actionStatus.state === 'loading'}
        onConfirm={() =>
          pendingAction?.kind === 'farm'
            ? handleDeleteFarm(pendingAction.id)
            : handleDeleteProduct(pendingAction?.id)
        }
        onCancel={() => setPendingAction(null)}
      />
    </div>
  );
}
