import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import {
  apiFetch,
  isUploadImage,
  resolveImageUrl,
  resolveUploadUrl,
} from '../lib/api.js';
import { supabase } from '../lib/supabase.js';
import { useAuth } from '../lib/auth.jsx';
import ConfirmDialog from '../components/ConfirmDialog.jsx';

export default function VendorProductsPage() {
  const { status: authStatus, user } = useAuth();
  const [products, setProducts] = useState([]);
  const [status, setStatus] = useState({
    state: 'loading',
    message: '',
  });
  const [pendingDelete, setPendingDelete] = useState(null);
  const [deleteStatus, setDeleteStatus] = useState({ state: 'idle', message: '' });

  const loadProducts = useCallback(async () => {
    try {
      const response = await apiFetch('/api/vendor/products', { method: 'GET' });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Unable to load products.');
      }
      setProducts(data.products || []);
      setStatus({ state: 'success', message: '' });
    } catch (error) {
      setStatus({
        state: 'error',
        message: error.message || 'Unable to load products.',
      });
    }
  }, []);

  useEffect(() => {
    if (authStatus !== 'authenticated' || !user || user.role !== 'vendor') {
      return;
    }

    loadProducts().catch(() => {});
  }, [authStatus, user, loadProducts]);

  useEffect(() => {
    if (authStatus !== 'authenticated' || !user || user.role !== 'vendor') {
      return;
    }

    let active = true;
    let channel = null;

    const subscribeToProducts = async () => {
      try {
        const response = await apiFetch('/api/vendor/profile', { method: 'GET' });
        const data = await response.json();
        const vendorId = data?.vendor?.id;
        if (!active || !vendorId) {
          return;
        }

        channel = supabase
          .channel(`vendor-products-${vendorId}`)
          .on(
            'postgres_changes',
            {
              event: '*',
              schema: 'public',
              table: 'products',
              filter: `farmer_id=eq.${vendorId}`,
            },
            () => {
              loadProducts().catch(() => {});
            },
          )
          .subscribe();
      } catch {
        // Ignore realtime setup failures and keep manual refresh behavior.
      }
    };

    subscribeToProducts().catch(() => {});

    return () => {
      active = false;
      if (channel) {
        supabase.removeChannel(channel);
      }
    };
  }, [authStatus, user, loadProducts]);

  const handleDeleteProduct = async () => {
    const productId = pendingDelete?.id;
    if (!productId) {
      return;
    }

    setDeleteStatus({ state: 'loading', message: '' });
    try {
      const response = await apiFetch(`/api/vendor/products/${productId}`, {
        method: 'DELETE',
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Unable to delete product.');
      }
      setProducts((prev) => prev.filter((product) => product.id !== productId));
      setPendingDelete(null);
      setDeleteStatus({ state: 'idle', message: '' });
    } catch (error) {
      setPendingDelete(null);
      setDeleteStatus({
        state: 'error',
        message: error.message || 'Unable to delete product.',
      });
    }
  };

  if (authStatus === 'loading') {
    return <div className="notice">Loading products...</div>;
  }

  if (!user || user.role !== 'vendor') {
    return (
      <div className="page-section">
        <h1>Vendor access required</h1>
        <p className="muted">
          Log in with a vendor account to view your products.
        </p>
        <Link className="button primary" to="/auth/login">
          Log in
        </Link>
      </div>
    );
  }

  return (
    <div className="page-section">
      <div className="section-header">
        <div>
          <h1>My uploaded products</h1>
          <p className="muted">Manage your product listings.</p>
        </div>
        <div className="button-group">
          <Link className="button ghost" to="/profile">
            Vendor Dashboard
          </Link>
          <Link className="button ghost" to="/markets">
            View markets
          </Link>
        </div>
      </div>

      <div className="form-card">
        {status.state === 'loading' && <div className="notice">Loading...</div>}
        {status.state === 'error' && (
          <div className="notice error" role="alert">
            {status.message}
          </div>
        )}
        {deleteStatus.state === 'error' && (
          <div className="notice error" role="alert">
            {deleteStatus.message}
          </div>
        )}

        <div className="products-list">
          {products.length === 0 && status.state === 'success' ? (
            <p className="muted">No products added yet.</p>
          ) : (
            products.map((product) => {
              const isUpload = isUploadImage(product.image);
              const imageUrl = product.image?.url
                ? isUpload
                  ? resolveUploadUrl(product.image.url)
                  : resolveImageUrl(product.image.url)
                : null;
              return (
                <div className="product-row" key={product.id}>
                  <div className="product-info">
                    <div className="product-thumb">
                      {imageUrl ? (
                        <img
                          src={imageUrl}
                          alt={product.image.alt || product.name}
                        />
                      ) : (
                        <span>{product.name?.charAt(0)?.toUpperCase() || '?'}</span>
                      )}
                    </div>
                    <div className="product-details">
                      <div className="product-title">
                        <strong>{product.name}</strong>
                        {product.type && (
                          <span className="muted">({product.type})</span>
                        )}
                      </div>
                      <p className="muted product-meta">
                        {product.category === 'fruits_and_vegetables'
                          ? 'Fruits and Vegetables'
                          : product.category === 'eggs'
                            ? 'Eggs'
                            : product.category === 'honey'
                              ? 'Honey Products'
                              : product.category}{' '}
                        · {product.unit} · {product.price} lei{' '}
                        ·{' '}
                        {`Rating ${Number(product.rating ?? 0)}/5`}
                        {product.instantBuy ? ' · Instant buy' : ' · Inquiry only'}
                      </p>
                      {isUpload ? (
                        <span className="badge ghost">Uploaded photo</span>
                      ) : (
                        product.image?.photographer &&
                          product.image?.photoUrl && (
                            <p className="muted photo-credit">
                              Photo by{' '}
                              <a
                                href={
                                  product.image.photographerUrl || product.image.photoUrl
                                }
                                target="_blank"
                                rel="noreferrer"
                              >
                                {product.image.photographer}
                              </a>{' '}
                              on{' '}
                              <a
                                href={product.image.photoUrl}
                                target="_blank"
                                rel="noreferrer"
                              >
                                Pexels
                              </a>
                            </p>
                          )
                      )}
                    </div>
                  </div>
                  <div className="product-actions">
                    <span className={product.available ? 'badge' : 'badge ghost'}>
                      {product.available ? 'Available' : 'Unavailable'}
                    </span>
                    <span className={product.instantBuy ? 'badge' : 'badge ghost'}>
                      {product.instantBuy ? 'Instant buy' : 'Inquiry only'}
                    </span>
                    <button
                      className="button danger small"
                      type="button"
                      onClick={() => setPendingDelete(product)}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
        <p className="muted photo-credit">
          <a href="https://www.pexels.com" target="_blank" rel="noreferrer">
            Photos provided by Pexels
          </a>
        </p>
      </div>

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title="Delete this product?"
        body={`"${pendingDelete?.name || 'This product'}" will be removed from the catalogue. This cannot be undone.`}
        confirmLabel="Delete product"
        busy={deleteStatus.state === 'loading'}
        onConfirm={handleDeleteProduct}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
