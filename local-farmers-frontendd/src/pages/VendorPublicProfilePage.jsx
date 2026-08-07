import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { apiFetch, resolveImageUrl } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import ProductCard from '../components/ProductCard.jsx';
import { OPERATOR } from '../lib/operator.js';

/** DSA art. 30(1)(e) — it changes which consumer rights apply. */
const TRADER_TYPE_LABELS = {
  company: 'Company (SRL/SA)',
  pfa: 'Authorised natural person (PFA)',
  individual_producer: 'Individual producer (producer certificate)',
  private_individual: 'Private individual — not a trader',
};

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
    // Empty until there is a paid order — the server decides, not the client.
    { label: 'Phone', value: vendor?.phoneNumber, href: vendor?.phoneNumber ? `tel:${vendor.phoneNumber}` : null },
    { label: 'Email', value: vendor?.email, href: vendor?.email ? `mailto:${vendor.email}` : null },
    { label: 'Address', value: [street, location].filter(Boolean).join(', ') },
    {
      label: 'Delivery',
      value:
        vendor?.deliveryRadiusKm === null || vendor?.deliveryRadiusKm === undefined
          ? null
          : `within ${vendor.deliveryRadiusKm} km`,
    },
  ].filter((row) => row.value);

  return (
    <div className="page-section">
      <header className="farm-hero">
        <div className="farm-hero-media">
          {coverImage ? (
            <img
              src={resolveImageUrl(coverImage)}
              alt={`${vendor?.farmName || 'Farm'} cover photo`}
            />
          ) : (
            <span aria-hidden="true">
              {(vendor?.farmName || '?').charAt(0).toUpperCase()}
            </span>
          )}
        </div>

        <div className="farm-hero-content">
          <p className="eyebrow">{location || 'Local farm'}</p>
          <h1>{vendor?.farmName || 'Farm profile'}</h1>
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
                Certified organic
              </span>
              <span className="tag">{state.products.length} products</span>
            </p>
          )}

          {vendor?.bio && <p className="farm-hero-bio prose">{vendor.bio}</p>}

          <div className="button-group">
            {vendor?.id && (
              <Link className="button primary" to={`/chat?vendorId=${vendor.id}`}>
                Ask the farmer
              </Link>
            )}
            <Link className="button ghost" to="/markets/fruits_and_vegetables">
              Browse markets
            </Link>
          </div>
        </div>
      </header>

      <article className="farm-public-card">
        {contactRows.length > 0 && (
          <section className="farm-block">
            <h2>Contact &amp; delivery</h2>
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

            {/* OPS-05 — phone and email used to render as tel:/mailto: for
                anyone at all. Now they appear once there is a paid order
                between you, and until then the chat is the channel — which is
                also the one we can moderate and keep a record of. */}
            {vendor?.contactVisible === false && (
              <p className="farm-contact-hidden">
                {vendor.contactHiddenReason}{' '}
                <Link to={`/chat?vendor=${vendor.id}`}>Message this farm</Link>
              </p>
            )}
          </section>
        )}

        {/* LEG-07 — DSA art. 30. Who you are actually contracting with. The
            platform is an intermediary; the farm is the seller, and customer
            terms §7.2 promises this block. */}
        {vendor?.trader && (
          <section className="farm-block farm-trader">
            <h2>Seller details</h2>
            <p className="muted">
              This farm sells to you directly. {OPERATOR.brand} is an intermediary and is not the
              seller of the goods.
            </p>
            <dl className="farm-contact-list">
              {vendor.trader.legalName && (
                <div className="farm-contact-row">
                  <dt>Registered name</dt>
                  <dd>{vendor.trader.legalName}</dd>
                </div>
              )}
              {vendor.trader.registrationNumber && (
                <div className="farm-contact-row">
                  <dt>Registration number</dt>
                  <dd>{vendor.trader.registrationNumber}</dd>
                </div>
              )}
              {vendor.trader.vatNumber && (
                <div className="farm-contact-row">
                  <dt>CUI / VAT</dt>
                  <dd>{vendor.trader.vatNumber}</dd>
                </div>
              )}
              {vendor.trader.registeredOffice && (
                <div className="farm-contact-row">
                  <dt>Registered office</dt>
                  <dd>{vendor.trader.registeredOffice}</dd>
                </div>
              )}
              {vendor.trader.traderType && vendor.trader.traderType !== 'unknown' && (
                <div className="farm-contact-row">
                  <dt>Trades as</dt>
                  <dd>{TRADER_TYPE_LABELS[vendor.trader.traderType] || vendor.trader.traderType}</dd>
                </div>
              )}
            </dl>

            {/* Visibly incomplete beats looking like there is nothing to
                declare. */}
            {!vendor.trader.isComplete && (
              <p className="farm-trader-incomplete">
                This farm has not supplied its full registration details yet. We have asked them
                for it.
              </p>
            )}
          </section>
        )}

        {galleryImages.length > 0 && (
          <section className="farm-block">
            <h2>From the farm</h2>
            <div className="farm-public-gallery">
              {galleryImages.map((imageUrl, index) => (
                <img
                  key={`${imageUrl}-${index}`}
                  src={resolveImageUrl(imageUrl)}
                  alt={`${vendor?.farmName || 'Farm'} photo ${index + 2}`}
                  loading="lazy"
                />
              ))}
            </div>
          </section>
        )}

        <section className="farm-block">
          <h2>Products from this farm</h2>
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
            <p className="muted">No products listed yet.</p>
          )}
        </section>
      </article>
    </div>
  );
}
