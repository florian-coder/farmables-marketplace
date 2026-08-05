import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { apiFetch, resolveImageUrl } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import ProductCard from '../components/ProductCard.jsx';

const initialState = {
  status: 'loading',
  vendor: null,
  products: [],
  error: '',
};


const formatValue = (value) => {
  if (value === null || value === undefined || value === '') {
    return 'Not provided';
  }
  return String(value);
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
        <div className="notice error" role="alert">{state.error}</div>
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
          <h2>Produse din fermă</h2>
          {state.products.length > 0 ? (
            <ul className="product-grid">
              {state.products.map((product) => (
                <ProductCard
                  key={product.id}
                  product={product}
                  vendor={{
                    id: vendor?.id,
                    farmName: vendor?.farmName,
                    city: vendor?.city,
                  }}
                  quantity={cartQuantities[product.id] ?? 1}
                  onQuantityChange={(productId, next) =>
                    setCartQuantities((prev) => ({ ...prev, [productId]: next }))
                  }
                  onAddToCart={handleAddToCart}
                  feedback={cartFeedback[product.id]}
                />
              ))}
            </ul>
          ) : (
            <p className="muted">Încă nu sunt produse listate.</p>
          )}
        </section>
      </article>
    </div>
  );
}
