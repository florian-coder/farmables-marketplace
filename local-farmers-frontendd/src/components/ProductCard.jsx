import { Link } from 'react-router-dom';

import { isUploadImage, resolveImageUrl, resolveUploadUrl } from '../lib/api.js';

const formatQuantity = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return '0';
  }
  if (Number.isInteger(parsed)) {
    return String(parsed);
  }
  return parsed.toFixed(2).replace(/\.?0+$/, '');
};

const formatPrice = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return '0.00';
  }
  return parsed.toFixed(2);
};

/**
 * LEG-06 — this is a popularity indicator, not a rating.
 *
 * The number behind it comes from src/lib/productRating.js, which computes it
 * from price, quantity sold and order count. It has never been an opinion from
 * a buyer. Showing it as a star with a decimal told customers "quality rated
 * by shoppers", which is a misleading commercial practice under Law 363/2007.
 *
 * So: no star, no decimals, and a label that says what the number is. Real
 * customer reviews, when they exist, get their own separate display.
 */
const TrendIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
       strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <polyline points="3 17 9 11 13 15 21 7" />
    <polyline points="21 7 21 12 16 7" />
  </svg>
);

/** 0-5 internal score rendered as five coarse buckets, never as a mark. */
const popularityLabel = (score) => {
  const value = Number(score);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  if (value >= 4.5) return 'Top seller';
  if (value >= 3.5) return 'Popular';
  if (value >= 2) return 'Selling well';
  return 'New';
};

export const resolveProductImage = (image) => {
  if (!image?.url) {
    return null;
  }
  return isUploadImage(image) ? resolveUploadUrl(image.url) : resolveImageUrl(image.url);
};

/**
 * The one product card in the app.
 * It used to exist in three places with three different markups; the one
 * in MarketsPage carried 24 inline style blocks.
 *
 * The photo runs edge to edge at a fixed ratio, so every card in a grid
 * is exactly the same size no matter what the source image measures.
 */
export default function ProductCard({
  product,
  vendor,
  fallbackImage = null,
  quantity = 1,
  onQuantityChange,
  onAddToCart,
  feedback,
}) {
  const image = product.image?.url ? product.image : fallbackImage;
  const imageUrl = resolveProductImage(image);

  const stock = Number(product.quantity || 0);
  const isOutOfStock = stock === 0;
  const isLowStock = !isOutOfStock && stock < 5;
  const canBuy = Boolean(product.instantBuy) && !isOutOfStock;

  const stockClass = isOutOfStock
    ? 'stock-badge-out'
    : isLowStock
      ? 'stock-badge-low'
      : 'stock-badge-ok';
  const stockLabel = isOutOfStock
    ? 'Out of stock'
    : isLowStock
      ? `Only ${formatQuantity(stock)} ${product.unit || ''}`.trim()
      : `In stock · ${formatQuantity(stock)} ${product.unit || ''}`.trim();

  const clamp = (next) => Math.max(1, Math.min(stock || 1, next));

  return (
    <li className={`product-card ${isOutOfStock ? 'is-out' : ''}`}>
      <div className="product-card-media">
        {imageUrl ? (
          <img src={imageUrl} alt={image.alt || product.name} loading="lazy" />
        ) : (
          <span aria-hidden="true">{product.name?.charAt(0)?.toUpperCase() || '?'}</span>
        )}
      </div>

      <div className="product-card-body">
        <h3 className="product-card-title">
          {product.name}
          {product.type ? <span className="product-card-type"> · {product.type}</span> : null}
        </h3>

        <p className="product-card-farm">
          {vendor?.id ? (
            <Link className="market-vendor-link" to={`/farms/${vendor.id}`}>
              {vendor.farmName || 'Local farm'}
            </Link>
          ) : (
            vendor?.farmName || 'Local farm'
          )}
          {vendor?.city ? <span className="product-card-place"> · {vendor.city}</span> : null}
        </p>

        <p className="product-card-price-container">
          <span className="product-card-price">{formatPrice(product.price)} RON</span>
          <span className="product-card-unit">/ {product.unit || 'unit'}</span>
        </p>

        <p className="product-card-meta">
          <span className={`stock-badge ${stockClass}`}>{stockLabel}</span>
          {popularityLabel(product.rating) && (
            <span
              className="product-card-popularity"
              title="Based on sales volume, not on customer reviews."
            >
              <TrendIcon />
              {popularityLabel(product.rating)}
            </span>
          )}
        </p>

        {vendor?.id && (
          <>
            <div className="product-card-actions">
              {product.instantBuy && (
                <div className={`quantity-wrapper ${isOutOfStock ? 'disabled' : ''}`}>
                  <button
                    className="quantity-btn"
                    type="button"
                    aria-label="Decrease quantity"
                    disabled={isOutOfStock}
                    onClick={() => onQuantityChange?.(product.id, clamp(quantity - 1))}
                  >
                    −
                  </button>
                  <input
                    className="quantity-input-custom"
                    type="number"
                    min="1"
                    max={stock || 1}
                    step="1"
                    aria-label={`Quantity for ${product.name}`}
                    value={quantity}
                    disabled={isOutOfStock}
                    onChange={(event) => {
                      const next = Number.parseFloat(event.target.value);
                      onQuantityChange?.(
                        product.id,
                        Number.isFinite(next) ? clamp(next) : 1,
                      );
                    }}
                  />
                  <button
                    className="quantity-btn"
                    type="button"
                    aria-label="Increase quantity"
                    disabled={isOutOfStock}
                    onClick={() => onQuantityChange?.(product.id, clamp(quantity + 1))}
                  >
                    +
                  </button>
                </div>
              )}
              <button
                className="button primary product-card-cta"
                type="button"
                disabled={!canBuy}
                onClick={() => onAddToCart?.(product)}
              >
                {isOutOfStock
                  ? 'Unavailable'
                  : product.instantBuy
                    ? 'Add to cart'
                    : 'On request'}
              </button>
            </div>

            <Link className="product-card-inquiry" to={`/chat?vendorId=${vendor.id}`}>
              Ask the farmer
            </Link>
          </>
        )}

        {feedback?.message && (
          <p
            className={`notice ${feedback.status === 'error' ? 'error' : 'success'} product-card-feedback`}
            role={feedback.status === 'error' ? 'alert' : 'status'}
          >
            {feedback.message}
          </p>
        )}
      </div>
    </li>
  );
}
