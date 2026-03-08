import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import {
  apiFetch,
  isUploadImage,
  resolveImageUrl,
  resolveUploadUrl,
} from '../lib/api.js';
import { getQualityLabel } from '../lib/quality.js';
import { useAuth } from '../lib/auth.jsx';

const initialState = {
  status: 'loading',
  markets: [],
  error: null,
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

export default function MarketsPage() {
  const { category } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [state, setState] = useState(initialState);
  const [productImages, setProductImages] = useState({});
  const requestedImagesRef = useRef(new Set());
  const [cartFeedback, setCartFeedback] = useState({});
  const [cartQuantities, setCartQuantities] = useState({});

  // Search and filter state
  const [searchQuery, setSearchQuery] = useState('');
  const [bioFilter, setBioFilter] = useState('all'); // all, bio, conventional
  const [maxPrice, setMaxPrice] = useState('');
  const [minRating, setMinRating] = useState('0');

  useEffect(() => {
    let active = true;

    const loadMarkets = async () => {
      try {
        const response = await apiFetch(`/api/markets/${category}`, { method: 'GET' });
        if (!response.ok) {
          throw new Error('Failed to load markets.');
        }
        const data = await response.json();
        if (!active) {
          return;
        }
        setState({ status: 'success', markets: data.markets || [], error: null });
      } catch (error) {
        if (!active) {
          return;
        }
        setState({
          status: 'error',
          markets: [],
          error: error.message || 'Unable to load markets.',
        });
      }
    };

    loadMarkets();

    return () => {
      active = false;
    };
  }, [category]);

  useEffect(() => {
    if (state.status !== 'success') {
      return;
    }

    let active = true;
    const missing = [];

    state.markets.forEach((market) => {
      (market.products || []).forEach((product) => {
        if (!product?.id) {
          return;
        }
        if (product.image?.url || requestedImagesRef.current.has(product.id)) {
          return;
        }
        requestedImagesRef.current.add(product.id);
        missing.push(product);
      });
    });

    if (missing.length === 0) {
      return;
    }

    const loadImages = async () => {
      const results = await Promise.all(
        missing.map(async (product) => {
          try {
            const name = encodeURIComponent(product.name || 'fresh vegetables');
            const response = await apiFetch(
              `/api/external/product-image?name=${name}`,
            );
            if (!response.ok) {
              return null;
            }
            const data = await response.json();
            const image = data?.image || null;
            if (!image?.url) {
              return null;
            }
            return {
              id: product.id,
              image,
            };
          } catch (error) {
            return null;
          }
        }),
      );

      if (!active) {
        return;
      }

      setProductImages((prev) => {
        const next = { ...prev };
        results.forEach((entry) => {
          if (entry?.id && entry.image?.url) {
            next[entry.id] = entry.image;
          }
        });
        return next;
      });
    };

    loadImages();

    return () => {
      active = false;
    };
  }, [state.status, state.markets]);

  const getPageInfo = () => {
    switch (category) {
      case 'fruits_and_vegetables':
        return {
          title: 'Fruits and Vegetables Market',
          description: 'Aggregated market signals, soil health estimates, and live pricing snapshots for fresh produce.',
          showSoil: true,
        };
      case 'meat':
        return {
          title: 'Meat Market',
          description: 'Direct access to local ranchers and butchers, with live pricing on sustainable meat products.',
          showSoil: false,
        };
      case 'dairy_products':
        return {
          title: 'Dairy Products Market',
          description: 'Fresh milk, cheese, and butter from local dairies with quality ratings and bio verification.',
          showSoil: false,
        };
      default:
        return {
          title: 'Markets',
          description: 'Explore our specialized local food markets.',
          showSoil: true,
        };
    }
  };

  const { title, description, showSoil } = getPageInfo();

  const filterProducts = (products) => {
    return (products || []).filter((product) => {
      const matchesSearch = product.name.toLowerCase().includes(searchQuery.toLowerCase());
      const matchesBio = bioFilter === 'all' || (bioFilter === 'bio' ? product.isBio : !product.isBio);
      const matchesPrice = maxPrice === '' || product.price <= parseFloat(maxPrice);
      const matchesRating = product.rating >= parseFloat(minRating);
      return matchesSearch && matchesBio && matchesPrice && matchesRating;
    });
  };

  const setFeedbackForProduct = (productId, status, message) => {
    if (!productId) {
      return;
    }
    setCartFeedback((prev) => ({
      ...prev,
      [productId]: {
        status,
        message,
      },
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
      setFeedbackForProduct(product.id, 'error', 'Instant buy is disabled for this product. Use Send inquiry.');
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

  return (
    <div className="page-section">
      <div className="section-header">
        <div>
          <h1>{title}</h1>
          <p className="muted">{description}</p>
        </div>
        <Link className="button ghost" to="/auth/signup?role=vendor">
          Become a vendor
        </Link>
      </div>

      <div className="filters-bar" style={{ marginBottom: '2rem', padding: '1rem', background: 'var(--surface)', borderRadius: 'var(--radius)', display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label className="field" style={{ margin: 0, flex: '1 1 200px' }}>
          Search products
          <input type="text" placeholder="Search..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
        </label>
        <label className="field" style={{ margin: 0 }}>
          Bio Status
          <select value={bioFilter} onChange={(e) => setBioFilter(e.target.value)}>
            <option value="all">All</option>
            <option value="bio">Bio Verified</option>
            <option value="conventional">Conventional</option>
          </select>
        </label>
        <label className="field" style={{ margin: 0 }}>
          Max Price
          <input type="number" placeholder="Any" value={maxPrice} onChange={(e) => setMaxPrice(e.target.value)} style={{ width: '80px' }} />
        </label>
        <label className="field" style={{ margin: 0 }}>
          Min Rating
          <select value={minRating} onChange={(e) => setMinRating(e.target.value)}>
            <option value="0">Any</option>
            <option value="3">3+ Stars</option>
            <option value="4">4+ Stars</option>
            <option value="4.5">4.5+ Stars</option>
          </select>
        </label>
      </div>

      {state.status === 'loading' && (
        <div className="notice">Loading markets...</div>
      )}
      {state.status === 'error' && (
        <div className="notice error">{state.error}</div>
      )}

      <div className="cards-grid">
        {state.markets.map((market) => (
          <article className="market-card" key={market.id}>
            <div className="market-card-header">
              <h2>{market.name}</h2>
              <span className="badge">{market.openStands} stands open</span>
            </div>
            <div className="market-meta">
              <div>
                <p className="label">Active growers</p>
                <p className="value">{market.activeGrowers}</p>
              </div>
              <div>
                <p className="label">Pickup points</p>
                <p className="value">{market.pickupPoints}</p>
              </div>
              {showSoil && (
                <div>
                  <p className="label">Soil quality</p>
                  <p className="value">{getQualityLabel(market.soil?.qualityScore)}</p>
                  <p className="muted">
                    Score {market.soil?.qualityScore ?? 'N/A'}
                  </p>
                </div>
              )}
            </div>
            {showSoil && (
              <div className="market-soil">
                <p className="label">Soil snapshot</p>
                <p className="muted">
                  pH {market.soil?.ph ?? '--'} · Organic carbon{' '}
                  {market.soil?.organicCarbon ?? '--'}
                </p>
              </div>
            )}
            <div className="market-news">
              <p className="label">Top market news</p>
              {market.marketNews && market.marketNews.length > 0 ? (
                <ul>
                  {market.marketNews.slice(0, 3).map((news) => (
                    <li key={news.commodity}>
                      <div className="market-news-item">
                        <div className="market-news-thumb">
                          {news.image?.url ? (
                            <img
                              src={resolveImageUrl(news.image.url)}
                              alt={news.image.alt || news.commodity}
                            />
                          ) : (
                            <span>
                              {news.commodity?.charAt(0)?.toUpperCase() || '?'}
                            </span>
                          )}
                        </div>
                        <div className="market-news-body">
                          <strong>{news.commodity}</strong>
                          <p className="muted">{news.headline}</p>
                          {Number.isFinite(news.priceRange?.min) &&
                            Number.isFinite(news.priceRange?.max) && (
                              <p className="muted">
                                ${news.priceRange.min} - ${news.priceRange.max}{' '}
                                {news.priceRange.unit}
                              </p>
                            )}
                          {news.image?.photographer && news.image?.photoUrl && (
                            <p className="muted photo-credit">
                              Photo by{' '}
                              <a
                                href={news.image.photographerUrl || news.image.photoUrl}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {news.image.photographer}
                              </a>{' '}
                              on{' '}
                              <a
                                href={news.image.photoUrl}
                                target="_blank"
                                rel="noreferrer"
                              >
                                Pexels
                              </a>
                            </p>
                          )}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">No market updates yet.</p>
              )}
            </div>
            <div className="market-products">
              <p className="label">Products from vendors</p>
              {market.products && market.products.length > 0 ? (
                <div className="categories-list">
                  {['fruits_and_vegetables', 'meat', 'dairy_products', 'other'].map((catKey) => {
                    if (catKey !== 'other' && catKey !== category) return null;
                    const catProducts = filterProducts(market.products).filter(p =>
                      catKey === 'other'
                        ? !['fruits_and_vegetables', 'meat', 'dairy_products'].includes(p.category)
                        : p.category === catKey
                    );
                    if (catProducts.length === 0) return null;
                    const catName = catKey === 'fruits_and_vegetables' ? 'Fruits and Vegetables' : catKey === 'meat' ? 'Meat' : catKey === 'dairy_products' ? 'Dairy Products' : 'Other';
                    return (
                      <div key={catKey} className="market-category" style={{ marginBottom: '1rem' }}>
                        <h4 style={{ margin: '0.5rem 0', fontSize: '1.1em' }}>{catName}</h4>
                        {['bio', 'conventional'].map((typeKey) => {
                          const typeProducts = catProducts.filter(p => typeKey === 'bio' ? p.isBio : !p.isBio);
                          if (typeProducts.length === 0) return null;
                          return (
                            <div key={typeKey} className="market-subcategory">
                              <h5 style={{ margin: '0.5rem 0 0.5rem 0.5rem', color: 'var(--ink-muted)', fontSize: '0.9em' }}>
                                {typeKey === 'bio' ? 'Bio Verified' : 'Conventional'}
                              </h5>
                              <ul>
                                {typeProducts.map((product) => {
                                  const resolvedImage = product.image?.url
                                    ? product.image
                                    : productImages[product.id];
                                  const resolvedImageUrl = resolvedImage?.url
                                    ? isUploadImage(resolvedImage)
                                      ? resolveUploadUrl(resolvedImage.url)
                                      : resolveImageUrl(resolvedImage.url)
                                    : null;
                                  return (
                                    <li key={product.id}>
                                      <div className="product-item">
                                        <div className="product-thumb">
                                          {resolvedImageUrl ? (
                                            <img
                                              src={resolvedImageUrl}
                                              alt={resolvedImage.alt || product.name}
                                            />
                                          ) : (
                                            <span>
                                              {product.name?.charAt(0)?.toUpperCase() || '?'}
                                            </span>
                                          )}
                                        </div>
                                        <div>
                                          <strong>{product.name}</strong> {product.type && <span className="muted">({product.type})</span>} · Qty: {formatQuantity(product.quantity)} {product.unit || 'unit'} · ${product.price}{' '}
                                          <span className="muted">
                                            (
                                            {product.vendor?.id ? (
                                              <Link
                                                className="market-vendor-link"
                                                to={`/farms/${product.vendor.id}`}
                                              >
                                                {product.vendor?.farmName || 'Vendor'}
                                              </Link>
                                            ) : (
                                              product.vendor?.farmName || 'Vendor'
                                            )}
                                            )
                                          </span>
                                          <div className="muted">
                                            {`Rating ${Number(product.rating ?? 0)}/5`}
                                          </div>
                                          {product.vendor?.id && (
                                            <div className="button-group" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
                                              <Link
                                                className="button ghost small market-chat-link"
                                                to={`/chat?vendorId=${product.vendor.id}`}
                                              >
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
                                                className="button secondary small market-cart-button"
                                                type="button"
                                                disabled={!product.instantBuy}
                                                onClick={() => handleAddToCart(product)}
                                              >
                                                {product.instantBuy
                                                  ? 'Add to cart'
                                                  : 'Inquiry only'}
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
                                          {resolvedImage?.photographer &&
                                            resolvedImage?.photoUrl &&
                                            !isUploadImage(resolvedImage) && (
                                              <div className="muted photo-credit">
                                                Photo by{' '}
                                                <a
                                                  href={
                                                    resolvedImage.photographerUrl ||
                                                    resolvedImage.photoUrl
                                                  }
                                                  target="_blank"
                                                  rel="noreferrer"
                                                >
                                                  {resolvedImage.photographer}
                                                </a>{' '}
                                                on{' '}
                                                <a
                                                  href={resolvedImage.photoUrl}
                                                  target="_blank"
                                                  rel="noreferrer"
                                                >
                                                  Pexels
                                                </a>
                                              </div>
                                            )}
                                        </div>
                                      </div>
                                    </li>
                                  );
                                })}
                              </ul>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="muted">No vendor products yet.</p>
              )}
              <p className="muted photo-credit">
                <a href="https://www.pexels.com" target="_blank" rel="noreferrer">
                  Photos provided by Pexels
                </a>
              </p>
            </div>
            <div className="market-global">
              <p className="label">Global context</p>
              <p className="muted">
                {market.globalStats?.item} ·{' '}
                {market.globalStats?.series?.length || 0} data points
              </p>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
