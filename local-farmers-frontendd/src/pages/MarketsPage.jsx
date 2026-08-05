import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { apiFetch } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import ProductCard from '../components/ProductCard.jsx';

const initialState = {
  status: 'loading',
  markets: [],
  error: null,
};

const SearchIcon = () => (
  <svg className="search-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="8"></circle>
    <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
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
      const ceiling = Number.parseFloat(maxPrice);
      const matchesPrice = !Number.isFinite(ceiling) || Number(product.price) <= ceiling;
      const minimum = Number.parseFloat(minRating) || 0;
      const matchesRating = Number(product.rating ?? 0) >= minimum;
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

  const setQuantity = (productId, nextQuantity) => {
    setCartQuantities((prev) => ({ ...prev, [productId]: nextQuantity }));
  };

  return (
    <div className="page-section">
      <div className="section-header">
        <div>
          <h1>{title}</h1>
          <p className="muted">{description}</p>
        </div>
        <Link className="button ghost" to="/auth/signup?role=vendor">
          Devino fermier partener
        </Link>
      </div>

      <div className="filters-bar">
        <div className="search-input-wrapper">
          <label className="field">
            Caută produse
            <span className="search-field">
              <SearchIcon />
              <input
                type="text"
                placeholder="Caută după nume..."
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
              />
            </span>
          </label>
        </div>
        <label className="field filters-field-narrow">
          Preț maxim
          <input
            type="number"
            min="0"
            step="0.5"
            placeholder="Oricare"
            value={maxPrice}
            onChange={(event) => setMaxPrice(event.target.value)}
          />
        </label>
        <label className="field filters-field-narrow">
          Rating minim
          <select value={minRating} onChange={(event) => setMinRating(event.target.value)}>
            <option value="0">Oricare</option>
            <option value="3">3+ stele</option>
            <option value="4">4+ stele</option>
            <option value="4.5">4,5+ stele</option>
          </select>
        </label>
      </div>

      {state.status === 'loading' && (
        <div className="notice">Loading markets...</div>
      )}
      {state.status === 'error' && (
        <div className="notice error" role="alert">{state.error}</div>
      )}

      <div className="markets-list">
        {state.markets.map((market) => {
          const visibleProducts = filterProducts(market.products);

          return (
            <section className="market-block" key={market.id}>
              <header className="market-header">
                <div>
                  <h2>{market.name}</h2>
                  <p className="muted">{description}</p>
                </div>
                <dl className="market-header-stats">
                  <div className="market-stat-item">
                    <dt className="market-stat-label">Fermieri</dt>
                    <dd className="market-stat-value">{market.activeGrowers}</dd>
                  </div>
                  <div className="market-stat-item">
                    <dt className="market-stat-label">Produse</dt>
                    <dd className="market-stat-value">{market.totalProducts}</dd>
                  </div>
                  <div className="market-stat-item">
                    <dt className="market-stat-label">Rating maxim</dt>
                    <dd className="market-stat-value">{market.biggestRating || '0.0'}</dd>
                  </div>
                </dl>
              </header>

              {visibleProducts.length > 0 ? (
                <ul className="product-grid">
                  {visibleProducts.map((product) => (
                    <ProductCard
                      key={product.id}
                      product={product}
                      vendor={product.vendor}
                      fallbackImage={productImages[product.id]}
                      quantity={cartQuantities[product.id] ?? 1}
                      onQuantityChange={setQuantity}
                      onAddToCart={handleAddToCart}
                      feedback={cartFeedback[product.id]}
                    />
                  ))}
                </ul>
              ) : (
                <p className="muted">
                  {market.products?.length > 0
                    ? 'Niciun produs nu se potrivește filtrelor tale.'
                    : 'Încă nu sunt produse în această piață.'}
                </p>
              )}
            </section>
          );
        })}
      </div>

      <p className="muted photo-credit photo-credit-center">
        <a href="https://www.pexels.com" target="_blank" rel="noreferrer">
          Photos provided by Pexels
        </a>
      </p>
    </div>
  );
}
