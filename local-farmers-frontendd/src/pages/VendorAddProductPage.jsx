import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { apiFetch, getApiBase } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import LabellingFields from '../components/LabellingFields.jsx';

const initialProduct = {
  name: '',
  category: 'fruits_and_vegetables',
  type: '',
  unit: 'kg',
  quantity: 0,
  price: 0,
  available: true,
  instantBuy: true,
  photo: null,
  batchCode: '',
  // LEG-04 — the mandatory particulars. The server refuses to publish without
  // them, so they are part of the form rather than an afterthought.
  labelling: {},
};

export default function VendorAddProductPage() {
  const { status: authStatus, user } = useAuth();
  const navigate = useNavigate();
  const [profileApproved, setProfileApproved] = useState(false);
  const [productForm, setProductForm] = useState(initialProduct);
  const [productStatus, setProductStatus] = useState({
    state: 'idle',
    message: '',
  });
  const [photoPreview, setPhotoPreview] = useState(null);
  const [photoInputKey, setPhotoInputKey] = useState(0);

  useEffect(() => {
    if (authStatus !== 'authenticated' || !user || user.role !== 'vendor') {
      return;
    }

    let active = true;

    const loadProfile = async () => {
      try {
        const response = await apiFetch('/api/vendor/profile', { method: 'GET' });
        const data = await response.json();
        if (!active) return;
        setProfileApproved(Boolean(data.profileApproved));
      } catch {
        if (!active) return;
      }
    };

    loadProfile();

    return () => {
      active = false;
    };
  }, [authStatus, user]);

  useEffect(() => {
    if (!productForm.photo) {
      setPhotoPreview(null);
      return;
    }
    const previewUrl = URL.createObjectURL(productForm.photo);
    setPhotoPreview(previewUrl);
    return () => URL.revokeObjectURL(previewUrl);
  }, [productForm.photo]);

  const handleProductChange = (event) => {
    const { name, value, type, checked, files } = event.target;
    setProductForm((prev) => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : type === 'file' ? files[0] : value,
    }));
  };

  const handleClearPhoto = () => {
    setProductForm((prev) => ({ ...prev, photo: null }));
    setPhotoInputKey((prev) => prev + 1);
  };

  const handleProductSubmit = async (event) => {
    event.preventDefault();
    if (!profileApproved) {
      setProductStatus({
        state: 'error',
        message: 'Your farm profile must be approved before adding products.',
      });
      return;
    }
    setProductStatus({ state: 'loading', message: 'Adding product...' });

    try {
      let imageUrl = null;
      if (productForm.photo) {
        const formData = new FormData();
        formData.append('photo', productForm.photo);
        const baseUrl = getApiBase();
        const uploadUrl = `${baseUrl}/api/vendor/upload-image`;
        const uploadResponse = await fetch(uploadUrl, {
          method: 'POST',
          body: formData,
          credentials: 'include',
        });

        const contentType = uploadResponse.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
          const uploadData = await uploadResponse.json();
          if (!uploadResponse.ok) {
            throw new Error(uploadData.error || 'Failed to upload image.');
          }
          imageUrl = uploadData.imageUrl;
        } else {
          throw new Error(`Server returned non-JSON response (${uploadResponse.status}).`);
        }
      }

      const payload = {
        ...productForm,
        quantity: Number(productForm.quantity),
        imageUrl,
      };
      delete payload.photo;
      const response = await apiFetch('/api/vendor/products', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok) {
        // LEG-04 — name the missing fields rather than saying "invalid".
        if (data.code === 'labelling_incomplete') {
          const missing = (data.missing || []).map((entry) => entry.label).join(', ');
          throw new Error(
            [data.error, missing && `Still needed: ${missing}.`, ...(data.problems || [])]
              .filter(Boolean)
              .join(' '),
          );
        }
        throw new Error(data.error || 'Unable to add product.');
      }
      setProductForm(initialProduct);
      setPhotoInputKey((prev) => prev + 1);
      setProductStatus({ state: 'success', message: 'Product added successfully!' });
      setTimeout(() => {
        navigate('/vendor/products_uploaded');
      }, 1500);
    } catch (error) {
      setProductStatus({
        state: 'error',
        message: error.message || 'Unable to add product.',
      });
    }
  };

  if (authStatus === 'loading') {
    return <div className="notice">Loading...</div>;
  }

  if (!user || user.role !== 'vendor') {
    return (
      <div className="page-section">
        <h1>Vendor access required</h1>
        <p className="muted">Log in with a vendor account to add products.</p>
        <Link className="button primary" to="/auth/login">Log in</Link>
      </div>
    );
  }

  return (
    <div className="page-section product-form-page">
      <div className="section-header">
        <div>
          <h1>Upload a product</h1>
          <p className="muted">
            Everything a customer needs to decide, and everything the law needs on the label.
          </p>
        </div>
        <Link className="button ghost" to="/vendor/products_uploaded">
          View all my products
        </Link>
      </div>

      {!profileApproved && (
        <p className="notice error" role="alert">
          Your farm profile is not approved yet. Products can only be added once your profile is
          approved.
        </p>
      )}

      <form className="product-form" onSubmit={handleProductSubmit}>
        {/* Grouped rather than run together: twelve fields in one column all
            look equally important, and the mandatory food information ends up
            reading like a footnote to the price. */}
        <section className="profile-card">
          <header className="profile-card-head">
            <h2>What you are selling</h2>
            <p className="profile-card-sub">This is what a customer sees first.</p>
          </header>
          <div className="profile-card-body">
            <div className="profile-fields">
              <label className="field is-wide">
                Product name
                <input
                  type="text"
                  name="name"
                  value={productForm.name}
                  onChange={handleProductChange}
                  placeholder="e.g. Cherry tomatoes"
                  required
                />
              </label>

              <label className="field">
                Category
                <select name="category" value={productForm.category} onChange={handleProductChange}>
                  <option value="fruits_and_vegetables">Fruits and vegetables</option>
                  <option value="eggs">Eggs</option>
                  <option value="honey">Honey</option>
                </select>
                <span className="muted field-hint">
                  Decides which market it appears in, and which label fields are required.
                </span>
              </label>

              <label className="field">
                Variety or type
                <input
                  type="text"
                  name="type"
                  placeholder="e.g. Cherry, Acacia, Free-range"
                  value={productForm.type}
                  onChange={handleProductChange}
                />
                <span className="muted field-hint">
                  Optional. The detail that tells two similar listings apart.
                </span>
              </label>
            </div>
          </div>
        </section>

        <section className="profile-card">
          <header className="profile-card-head">
            <h2>Price and stock</h2>
            <p className="profile-card-sub">
              Your price is what the customer sees. The platform fee is added on top of it, not
              taken out of it.
            </p>
          </header>
          <div className="profile-card-body">
            <div className="profile-fields product-form-money">
              <label className="field">
                Price
                <span className="input-affix">
                  <input
                    type="number"
                    name="price"
                    step="0.01"
                    min="0"
                    value={productForm.price}
                    onChange={handleProductChange}
                    required
                  />
                  <span className="input-affix-unit">RON</span>
                </span>
              </label>

              <label className="field">
                Unit
                <input
                  type="text"
                  name="unit"
                  value={productForm.unit}
                  onChange={handleProductChange}
                  placeholder="kg"
                />
              </label>

              <label className="field">
                Quantity in stock
                <input
                  type="number"
                  name="quantity"
                  min="0"
                  step="0.01"
                  value={productForm.quantity}
                  onChange={handleProductChange}
                  required
                />
              </label>
            </div>

            <div className="product-form-toggles">
              <label className="field checkbox">
                <input
                  type="checkbox"
                  name="available"
                  checked={productForm.available}
                  onChange={handleProductChange}
                />
                <span>
                  Available now
                  <span className="muted field-hint">Uncheck to keep it saved but hidden.</span>
                </span>
              </label>

              <label className="field checkbox">
                <input
                  type="checkbox"
                  name="instantBuy"
                  checked={productForm.instantBuy}
                  onChange={handleProductChange}
                />
                <span>
                  Instant buy
                  <span className="muted field-hint">
                    Off means customers message you instead of adding it to a basket.
                  </span>
                </span>
              </label>
            </div>
          </div>
        </section>

        <section className="profile-card">
          <header className="profile-card-head">
            <h2>Photo</h2>
            <p className="profile-card-sub">
              Optional. Max 5MB · JPG, PNG or WebP. We fall back to a stock photo.
            </p>
          </header>
          <div className="profile-card-body">
            <div className="upload-card">
              <div className="upload-preview">
                {photoPreview ? (
                  <img src={photoPreview} alt="Selected product" />
                ) : (
                  <div className="upload-placeholder">No photo yet</div>
                )}
              </div>
              <div className="upload-controls">
                <label className="field">
                  Choose a file
                  <input
                    key={photoInputKey}
                    type="file"
                    name="photo"
                    accept="image/*"
                    onChange={handleProductChange}
                  />
                </label>
                {productForm.photo && (
                  <>
                    <p className="upload-meta">
                      <span>{productForm.photo.name}</span>
                      <span>{(productForm.photo.size / (1024 * 1024)).toFixed(1)} MB</span>
                    </p>
                    <button className="button ghost small" type="button" onClick={handleClearPhoto}>
                      Remove photo
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </section>

        {/* LEG-04 — the server refuses to publish without these, so they get a
            card of their own rather than a fieldset buried mid-form. */}
        <section className="profile-card">
          <header className="profile-card-head">
            <h2>Food information</h2>
            <p className="profile-card-sub">
              Required by Reg. 1169/2011. A product cannot be published without it.
            </p>
          </header>
          <div className="profile-card-body">
            <LabellingFields
              category={productForm.category}
              labelling={productForm.labelling}
              onChange={(labelling) => setProductForm((prev) => ({ ...prev, labelling }))}
            />

            <label className="field">
              Batch code
              <input
                type="text"
                name="batchCode"
                value={productForm.batchCode}
                onChange={handleProductChange}
                placeholder="Your own reference for this batch"
              />
              {/* Reg. 178/2002 art. 18: a recall has to be able to find the
                  batch. What you call it is up to you. */}
              <span className="muted field-hint">
                Optional, but it is how a recall would find this batch.
              </span>
            </label>
          </div>
        </section>

        <div className="product-form-foot">
          {productStatus.message && (
            <p
              className={`notice ${productStatus.state === 'error' ? 'error' : 'success'}`}
              role="status"
            >
              {productStatus.message}
            </p>
          )}
          <button
            className="button primary"
            type="submit"
            disabled={productStatus.state === 'loading'}
          >
            {productStatus.state === 'loading' ? 'Adding…' : 'Add product'}
          </button>
        </div>
      </form>
    </div>
  );
}