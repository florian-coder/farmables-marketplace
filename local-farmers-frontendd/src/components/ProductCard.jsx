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
    return '0,00';
  }
  return parsed.toFixed(2).replace('.', ',');
};

const StarIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
  </svg>
);

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
          <span className="product-card-price">{formatPrice(product.price)} lei</span>
          <span className="product-card-unit">/ {product.unit || 'buc'}</span>
        </p>

        <p className="product-card-meta">
          <span className={`stock-badge ${stockClass}`}>{stockLabel}</span>
          <span className="product-card-rating">
            <StarIcon />
            {Number(product.rating ?? 0).toFixed(1)}
          </span>
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
