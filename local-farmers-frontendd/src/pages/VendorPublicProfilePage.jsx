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
  const location = [vendor?.city, vendor?.county].filter(Boolean).join(', ');
  const street = [vendor?.streetAddress, vendor?.streetNumber].filter(Boolean).join(' ');
  const coverImage = vendor?.farmImages?.[0] || null;
  const galleryImages = vendor?.farmImages?.slice(1) || [];

  const contactRows = [
    { label: 'Telefon', value: vendor?.phoneNumber, href: vendor?.phoneNumber ? `tel:${vendor.phoneNumber}` : null },
    { label: 'Email', value: vendor?.email, href: vendor?.email ? `mailto:${vendor.email}` : null },
    { label: 'Adresă', value: [street, location].filter(Boolean).join(', ') },
    {
      label: 'Livrare',
      value:
        vendor?.deliveryRadiusKm === null || vendor?.deliveryRadiusKm === undefined
          ? null
          : `în raza de ${vendor.deliveryRadiusKm} km`,
    },
  ].filter((row) => row.value);

  return (
    <div className="page-section">
      <header className="farm-hero">
        <div className="farm-hero-media">
          {coverImage ? (
            <img
              src={resolveImageUrl(coverImage)}
              alt={`${vendor?.farmName || 'Fermă'} — fotografie`}
            />
          ) : (
            <span aria-hidden="true">
              {(vendor?.farmName || '?').charAt(0).toUpperCase()}
            </span>
          )}
        </div>

        <div className="farm-hero-content">
          <p className="eyebrow">{location || 'Fermă locală'}</p>
          <h1>{vendor?.farmName || 'Profil de fermă'}</h1>
          {vendor?.displayName && vendor.displayName !== vendor.farmName && (
            <p className="muted">{vendor.displayName}</p>
          )}

          {vendor?.organicCertificate && (
            <p className="farm-hero-tags">
              <span className="tag bio">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z" />
                  <path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12" />
                </svg>
                Certificat bio
              </span>
              <span className="tag">{state.products.length} produse</span>
            </p>
          )}

          {vendor?.bio && <p className="farm-hero-bio prose">{vendor.bio}</p>}

          <div className="button-group">
            {vendor?.id && (
              <Link className="button primary" to={`/chat?vendorId=${vendor.id}`}>
                Întreabă fermierul
              </Link>
            )}
            <Link className="button ghost" to="/markets/fruits_and_vegetables">
              Vezi piețele
            </Link>
          </div>
        </div>
      </header>

      <article className="farm-public-card">
        {contactRows.length > 0 && (
          <section className="farm-block">
            <h2>Contact și livrare</h2>
            <dl className="farm-contact-list">
              {contactRows.map((row) => (
                <div className="farm-contact-row" key={row.label}>
                  <dt>{row.label}</dt>
                  <dd>
                    {row.href ? <a href={row.href}>{row.value}</a> : row.value}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        )}

        {galleryImages.length > 0 && (
          <section className="farm-block">
            <h2>Din fermă</h2>
            <div className="farm-public-gallery">
              {galleryImages.map((imageUrl, index) => (
                <img
                  key={`${imageUrl}-${index}`}
                  src={resolveImageUrl(imageUrl)}
                  alt={`${vendor?.farmName || 'Fermă'} — fotografia ${index + 2}`}
                  loading="lazy"
                />
              ))}
            </div>
          </section>
        )}

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
