import { useEffect, useRef, useState } from 'react';
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

const SearchIcon = () => (
  <svg className="search-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="8"></circle>
    <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
  </svg>
);

const UsersIcon = () => (
  <svg className="market-stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
    <circle cx="9" cy="7" r="4"></circle>
    <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
    <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
  </svg>
);

const BoxIcon = () => (
  <svg className="market-stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
    <polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline>
    <line x1="12" y1="22.08" x2="12" y2="12"></line>
  </svg>
);

const StarIcon = () => (
  <svg className="market-stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
  </svg>
);

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
          description: 'Aggregated market signals and live pricing snapshots for fresh produce.',
        };
      case 'eggs':
        return {
          title: 'Eggs',
          description: 'Direct access to local ranchers and butchers, with live pricing on sustainable eggs products.',
        };
      case 'honey':
        return {
          title: 'Honey Products Market',
          description: 'Fresh milk, cheese, and butter from local dairies with quality ratings and bio verification.',
        };
      default:
        return {
          title: 'Markets',
          description: 'Explore our specialized local food markets.',
        };
    }
  };

  const { title, description } = getPageInfo();

  const filterProducts = (products) => {
    return (products || []).filter((product) => {
      const matchesSearch = product.name.toLowerCase().includes(searchQuery.toLowerCase());
      const matchesPrice = maxPrice === '' || product.price <= parseFloat(maxPrice);
      const matchesRating = product.rating >= parseFloat(minRating);
      return matchesSearch && matchesPrice && matchesRating;
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

  const updateQuantity = (productId, delta, max) => {
    setCartQuantities((prev) => {
      const current = prev[productId] ?? 1;
      const next = Math.max(1, Math.min(max || 999, current + delta));
      return { ...prev, [productId]: next };
    });
  };

  return (
    <div className="page-section">
      <div className="section-header" style={{ marginBottom: '1rem' }}>
        <div>
          <h1>{title}</h1>
          <p className="muted" style={{ fontWeight: 500, color: '#4b5563' }}>{description}</p>
        </div>
        <Link className="button ghost" to="/auth/signup?role=vendor">
          Become a vendor
        </Link>
      </div>

      <div className="filters-bar" style={{ marginBottom: '2.5rem', padding: '1.25rem', borderRadius: '14px', display: 'flex', gap: '1.25rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div className="search-input-wrapper">
          <label className="field" style={{ margin: 0 }}>
            Search products
            <div style={{ position: 'relative' }}>
              <SearchIcon />
              <input 
                type="text" 
                placeholder="Search by name..." 
                value={searchQuery} 
                onChange={(e) => setSearchQuery(e.target.value)} 
              />
            </div>
          </label>
        </div>
        <label className="field" style={{ margin: 0 }}>
          Max Price
          <input type="number" placeholder="Any" value={maxPrice} onChange={(e) => setMaxPrice(e.target.value)} style={{ width: '110px' }} />
        </label>
        <label className="field" style={{ margin: 0 }}>
          Min Rating
          <select value={minRating} onChange={(e) => setMinRating(e.target.value)}>
            <option value="0">Any rating</option>
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

      <div className="cards-grid" style={{ gridTemplateColumns: '1fr' }}>
        {state.markets.map((market) => (
          <article className="market-card" key={market.id} style={{ background: 'transparent', border: 'none', boxShadow: 'none', padding: 0 }}>
            
            <div className="market-hero-banner">
              <h2>{market.name}</h2>
              <div className="market-hero-stats">
                <div className="market-stat-item">
                  <UsersIcon />
                  <span className="market-stat-label">Active growers</span>
                  <span className="market-stat-value">{market.activeGrowers}</span>
                </div>
                <div className="market-stat-item">
                  <BoxIcon />
                  <span className="market-stat-label">Products</span>
                  <span className="market-stat-value">{market.totalProducts}</span>
                </div>
                <div className="market-stat-item">
                  <StarIcon />
                  <span className="market-stat-label">Biggest rating</span>
                  <span className="market-stat-value">{market.biggestRating || '0.0'}</span>
                </div>
              </div>
            </div>
            
            <div className="market-products">
              <p className="label" style={{ marginBottom: '1.5rem', fontSize: '0.85rem', color: '#374151' }}>Available products in this category</p>
              {market.products && market.products.length > 0 ? (
                <div className="categories-list">
                  {['fruits_and_vegetables', 'eggs', 'honey', 'other'].map((catKey) => {
                    if (catKey !== 'other' && catKey !== category) return null;
                    const catProducts = filterProducts(market.products).filter(p =>
                      catKey === 'other'
                        ? !['fruits_and_vegetables', 'eggs', 'honey'].includes(p.category)
                        : p.category === catKey
                    );
                    if (catProducts.length === 0) return null;
                    const catName = catKey === 'fruits_and_vegetables' ? 'Fruits and Vegetables' : catKey === 'eggs' ? 'Eggs' : catKey === 'honey' ? 'Honey Products' : 'Other';
                    
                    return (
                      <div key={catKey} className="market-category" style={{ marginBottom: '2.5rem' }}>
                        <h3 style={{ marginBottom: '1.5rem', fontSize: '1.5rem' }}>{catName}</h3>
                        
                        <div className="product-grid">
                          {catProducts.map((product) => {
                            const resolvedImage = product.image?.url
                              ? product.image
                              : productImages[product.id];
                            const resolvedImageUrl = resolvedImage?.url
                              ? isUploadImage(resolvedImage)
                                ? resolveUploadUrl(resolvedImage.url)
                                : resolveImageUrl(resolvedImage.url)
                              : null;
                            
                            const stock = Number(product.quantity || 0);
                            const isOutOfStock = stock === 0;

                            return (
                              <li key={product.id} className="product-card" style={{ opacity: isOutOfStock ? 0.8 : 1 }}>
                                <div className="product-thumb" style={{ width: '100%', height: '180px', borderRadius: '10px', marginBottom: '0.25rem', overflow: 'hidden', background: '#f3f4f6', filter: isOutOfStock ? 'grayscale(0.5)' : 'none' }}>
                                  {resolvedImageUrl ? (
                                    <img
                                      src={resolvedImageUrl}
                                      alt={resolvedImage.alt || product.name}
                                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                                    />
                                  ) : (
                                    <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#e5e7eb', color: '#9ca3af', fontSize: '2.5rem', fontWeight: 700 }}>
                                      {product.name?.charAt(0)?.toUpperCase() || '?'}
                                    </div>
                                  )}
                                </div>
                                
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                                  <h4 className="product-card-title">{product.name}</h4>
                                  <p className="product-card-farm">
                                    {product.vendor?.id ? (
                                      <Link className="market-vendor-link" to={`/farms/${product.vendor.id}`}>
                                        {product.vendor?.farmName || 'Vendor'}
                                      </Link>
                                    ) : (
                                      product.vendor?.farmName || 'Vendor'
                                    )}
                                  </p>
                                </div>

                                <div className="product-card-price-container">
                                  <p className="product-card-price">${product.price}</p>
                                  <span className="product-card-unit">/ {product.unit || 'unit'}</span>
                                </div>

                                <div className="product-rating-stock-row">
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontWeight: 600, color: '#4b5563', fontSize: '0.85rem' }}>
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="#fbbf24" stroke="#fbbf24"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>
                                    {Number(product.rating ?? 0).toFixed(1)}
                                  </div>
                                  <span className={`stock-badge ${isOutOfStock ? 'stock-badge-out' : stock < 5 ? 'stock-badge-low' : 'stock-badge-ok'}`}>
                                    {isOutOfStock ? 'Out of Stock' : `Stock: ${formatQuantity(stock)}`}
                                  </span>
                                </div>

                                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '0.5rem' }}>
                                  {product.vendor?.id && (
                                    <>
                                      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                                        {product.instantBuy && (
                                          <div className={`quantity-wrapper ${isOutOfStock ? 'disabled' : ''}`}>
                                            <button 
                                              type="button" 
                                              className="quantity-btn"
                                              onClick={() => updateQuantity(product.id, -1, product.quantity)}
                                              disabled={isOutOfStock}
                                            >
                                              −
                                            </button>
                                            <input
                                              type="number"
                                              className="quantity-input-custom"
                                              value={cartQuantities[product.id] ?? 1}
                                              readOnly
                                            />
                                            <button 
                                              type="button" 
                                              className="quantity-btn"
                                              onClick={() => updateQuantity(product.id, 1, product.quantity)}
                                              disabled={isOutOfStock}
                                            >
                                              +
                                            </button>
                                          </div>
                                        )}
                                        <button
                                          className="btn-cart-primary"
                                          type="button"
                                          disabled={!product.instantBuy || isOutOfStock}
                                          onClick={() => handleAddToCart(product)}
                                        >
                                          {isOutOfStock ? 'Unavailable' : 'Add to cart'}
                                        </button>
                                      </div>
                                      
                                      <Link
                                        className="btn-inquiry-secondary"
                                        style={{ textAlign: 'center', textDecoration: 'none' }}
                                        to={`/chat?vendorId=${product.vendor.id}`}
                                      >
                                        Send inquiry
                                      </Link>
                                    </>
                                  )}
                                </div>

                                {cartFeedback[product.id]?.message && (
                                  <p className={`notice ${cartFeedback[product.id]?.status === 'error' ? 'error' : 'success'}`} style={{ fontSize: '0.8rem', padding: '8px', marginTop: '8px' }}>
                                    {cartFeedback[product.id].message}
                                  </p>
                                )}
                              </li>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="muted">No vendor products yet.</p>
              )}
            </div>
          </article>
        ))}
      </div>
      
      <p className="muted photo-credit" style={{ textAlign: 'center', marginTop: '3rem' }}>
        <a href="https://www.pexels.com" target="_blank" rel="noreferrer">
          Photos provided by Pexels
        </a>
      </p>
    </div>
  );
}
