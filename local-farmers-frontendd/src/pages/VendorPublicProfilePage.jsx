import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import {
  apiFetch,
  isUploadImage,
  resolveImageUrl,
  resolveUploadUrl,
} from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';

const initialState = {
  status: 'loading',
  vendor: null,
  products: [],
  error: '',
};

const toLabel = (category) => {
  if (category === 'fruits_and_vegetables') {
    return 'Fruits and Vegetables';
  }
  if (category === 'eggs') {
    return 'Eggs';
  }
  if (category === 'honey') {
    return 'Honey Products';
  }
  return category || 'Other';
};

const formatValue = (value) => {
  if (value === null || value === undefined || value === '') {
    return 'Not provided';
  }
  return String(value);
};

const formatQuantity = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 'N/A';
  }
  if (Number.isInteger(parsed)) {
    return String(parsed);
  }
  return parsed.toFixed(2).replace(/\.?0+$/, '');
};

export default function VendorPublicProfilePage() {
  const { vendorId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [state, setState] = useState(initialState);
  const [cartFeedback, setCartFeedback] = useState({});
  const [cartQuantities, setCartQuantities] = useState({});

  const setFeedbackForProduct = (productId, status, message) => {
    if (!productId) {
      return;
    }
    setCartFeedback((prev) => ({
      ...prev,
      [productId]: { status, message },
    }));
  };

  const handleAddToCart = async (product) => {
    if (!product?.id) {
      return;
    }
    if (!user) {
      navigate('/auth/login');
      return;
    }
    if (user.role !== 'customer') {
      setFeedbackForProduct(product.id, 'error', 'Only customers can add products to cart.');
      return;
    }
    if (!product.instantBuy) {
      setFeedbackForProduct(product.id, 'error', 'Instant buy is disabled. Use Send inquiry.');
      return;
    }

    setFeedbackForProduct(product.id, 'loading', 'Adding to cart...');
    try {
      const quantity = cartQuantities[product.id] || 1;
      const response = await apiFetch('/api/orders/cart/items', {
        method: 'POST',
        body: JSON.stringify({
          productId: product.id,
          quantity: quantity,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Unable to add product to cart.');
      }
      setFeedbackForProduct(product.id, 'success', 'Added to cart.');
    } catch (error) {
      setFeedbackForProduct(
        product.id,
        'error',
        error.message || 'Unable to add product to cart.',
      );
    }
  };

  useEffect(() => {
    if (!vendorId) {
      setState({
        status: 'error',
        vendor: null,
        products: [],
        error: 'Vendor id is missing.',
      });
      return;
    }

    let active = true;
    const loadVendor = async () => {
      setState((prev) => ({ ...prev, status: 'loading', error: '' }));
      try {
        const response = await apiFetch(`/api/vendors/${vendorId}`, { method: 'GET' });
        const data = await response.json();
        if (!active) {
          return;
        }
        if (!response.ok) {
          throw new Error(data.error || 'Unable to load farm profile.');
        }

        setState({
          status: 'success',
          vendor: data.vendor || null,
          products: data.products || [],
          error: '',
        });
      } catch (error) {
        if (!active) {
          return;
        }
        setState({
          status: 'error',
          vendor: null,
          products: [],
          error: error.message || 'Unable to load farm profile.',
        });
      }
    };

    loadVendor();

    return () => {
      active = false;
    };
  }, [vendorId]);

  if (state.status === 'loading') {
    return <div className="notice">Loading farm profile...</div>;
  }

  if (state.status === 'error') {
    return (
      <div className="page-section">
        <div className="notice error">{state.error}</div>
        <Link className="button ghost" to="/markets/fruits_and_vegetables">
          Back to markets
        </Link>
      </div>
    );
  }

  const vendor = state.vendor;
  const profileRows = [
    { label: 'Farm name', value: vendor?.farmName },
    { label: 'Display name', value: vendor?.displayName },
    { label: 'Street address', value: vendor?.streetAddress },
    { label: 'Street number', value: vendor?.streetNumber },
    { label: 'County', value: vendor?.county },
    { label: 'City', value: vendor?.city },
    { label: 'Phone number', value: vendor?.phoneNumber },
    { label: 'Email', value: vendor?.email },
    {
      label: 'Delivery radius (km)',
      value:
        vendor?.deliveryRadiusKm === null || vendor?.deliveryRadiusKm === undefined
          ? ''
          : vendor.deliveryRadiusKm,
    },
    { label: 'Bio', value: vendor?.bio },
  ];

  return (
    <div className="page-section">
      <div className="section-header">
        <div>
          <h1>{vendor?.farmName || 'Farm profile'}</h1>
          <p className="muted">Public farm page</p>
        </div>
        <div className="button-group">
          {vendor?.id && (
            <Link className="button primary" to={`/chat?vendorId=${vendor.id}`}>
              Send inquiry
            </Link>
          )}
          <Link className="button ghost" to="/markets/fruits_and_vegetables">
            View markets
          </Link>
          <Link className="button ghost" to="/profile">
            My profile
          </Link>
        </div>
      </div>

      <article className="form-card farm-public-card">
        <div className="farm-linear-list">
          {profileRows.map((row) => (
            <div className="farm-linear-row" key={row.label}>
              <p className="farm-linear-label">{row.label}</p>
              <p className="farm-linear-value">{formatValue(row.value)}</p>
            </div>
          ))}
        </div>

        <section className="farm-block">
          <h2>Farm gallery (up to 10 images)</h2>
          {vendor?.farmImages?.length > 0 ? (
            <div className="farm-public-gallery">
              {vendor.farmImages.map((imageUrl, index) => (
                <img
                  key={`${imageUrl}-${index}`}
                  src={resolveImageUrl(imageUrl)}
                  alt={`${vendor.farmName || 'Farm'} image ${index + 1}`}
                />
              ))}
            </div>
          ) : (
            <p className="muted">No farm images uploaded.</p>
          )}
        </section>

        <section className="farm-block">
          <h2>Products listed</h2>
          {state.products.length > 0 ? (
            <div className="farm-products-list">
              {state.products.map((product) => {
                const hasUploadImage = isUploadImage(product.image);
                const imageUrl = product.image?.url
                  ? hasUploadImage
                    ? resolveUploadUrl(product.image.url)
                    : resolveImageUrl(product.image.url)
                  : null;

                return (
                  <div className="farm-product-row" key={product.id}>
                    <div className="farm-product-image">
                      {imageUrl ? (
                        <img
                          src={imageUrl}
                          alt={product.image?.alt || product.name}
                        />
                      ) : (
                        <span>{product.name?.charAt(0)?.toUpperCase() || '?'}</span>
                      )}
                    </div>
                    <div className="farm-product-content">
                      <p className="farm-product-title">
                        {product.name}
                        {product.type ? ` (${product.type})` : ''}
                      </p>
                      <p className="muted">
                        {toLabel(product.category)} · Qty: {formatQuantity(product.quantity)}{' '}
                        {product.unit || 'unit'} ·{' '}
                        {product.price !== null && product.price !== undefined
                          ? `$${product.price}`
                          : 'Price N/A'}
                      </p>
                      <p className="muted">
                        {`Rating ${Number(product.rating ?? 0)}/5`} ·{' '}
                        {product.isBio ? 'Bio verified' : 'Conventional'} ·{' '}
                        {product.available ? 'Available' : 'Unavailable'} ·{' '}
                        {product.instantBuy ? 'Instant buy' : 'Inquiry only'}
                      </p>
                      {vendor?.id && (
                        <div className="button-group" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
                          <Link className="button ghost small" to={`/chat?vendorId=${vendor.id}`}>
                            Send inquiry
                          </Link>
                          {product.instantBuy && (
                            <input
                              type="number"
                              min="1"
                              max={product.quantity || 1}
                              step="any"
                              value={cartQuantities[product.id] ?? 1}
                              onChange={(e) => {
                                const val = e.target.value === '' ? '' : parseFloat(e.target.value);
                                setCartQuantities((prev) => ({
                                  ...prev,
                                  [product.id]: val,
                                }));
                              }}
                              style={{ width: '80px', padding: '0.4rem', border: '1px solid #ccc', borderRadius: '4px' }}
                              title="Quantity"
                            />
                          )}
                          <button
                            className="button secondary small"
                            type="button"
                            disabled={!product.instantBuy}
                            onClick={() => handleAddToCart(product)}
                          >
                            {product.instantBuy ? 'Add to cart' : 'Inquiry only'}
                          </button>
                        </div>
                      )}
                      {cartFeedback[product.id]?.message && (
                        <p
                          className={`notice ${
                            cartFeedback[product.id]?.status === 'error'
                              ? 'error'
                              : cartFeedback[product.id]?.status === 'success'
                                ? 'success'
                                : ''
                          }`}
                        >
                          {cartFeedback[product.id].message}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="muted">No products listed yet.</p>
          )}
        </section>
      </article>
    </div>
  );
}
