import { useEffect, useState, useRef } from 'react';
import { Link } from 'react-router-dom';

import { apiFetch, getApiBase, resolveImageUrl } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';

const MAX_FARM_IMAGES = 10;

const initialProfile = {
  id: '',
  farmName: '',
  displayName: '',
  streetAddress: '',
  streetNumber: '',
  county: '',
  city: '',
  phoneNumber: '',
  email: '',
  organicCertificate: '',
  deliveryRadiusKm: '',
  bio: '',
  farmImages: [],
  documents: {},
  entityType: 'pf',
  product_oua: false,
  product_miere: false,
};

const normalizeFarmImages = (images) => {
  if (!Array.isArray(images)) {
    return [];
  }

  const seen = new Set();
  const normalized = [];
  for (const imageUrl of images) {
    if (typeof imageUrl !== 'string') {
      continue;
    }
    const trimmed = imageUrl.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
    if (normalized.length >= MAX_FARM_IMAGES) {
      break;
    }
  }
  return normalized;
};

const mapVendorToProfile = (vendor) => ({
  id: vendor?.id || '',
  farmName: vendor?.farmName || '',
  displayName: vendor?.displayName || '',
  streetAddress: vendor?.streetAddress || '',
  streetNumber: vendor?.streetNumber || '',
  county: vendor?.county || '',
  city: vendor?.city || '',
  phoneNumber: vendor?.phoneNumber || '',
  email: vendor?.email || '',
  organicCertificate: vendor?.organicCertificate || '',
  deliveryRadiusKm: vendor?.deliveryRadiusKm ?? '',
  bio: vendor?.bio || '',
  farmImages: normalizeFarmImages(vendor?.farmImages),
  documents: vendor?.documents || {},
  entityType: vendor?.documents?.cui ? 'juridica' : 'pf',
  product_oua: !!vendor?.documents?.sanitary_doc_egg,
  product_miere: !!vendor?.documents?.sanitary_doc_honey,
});

export default function VendorPage() {
  const { status: authStatus, user } = useAuth();
  const [profile, setProfile] = useState(initialProfile);
  const [profileApproved, setProfileApproved] = useState(false);
  const [requestStatus, setRequestStatus] = useState('not_submitted');
  const [requestReviewNote, setRequestReviewNote] = useState('');
  const [profileStatus, setProfileStatus] = useState({
    state: 'idle',
    message: '',
  });
  const [farmUploadStatus, setFarmUploadStatus] = useState({
    state: 'idle',
    message: '',
  });
  const [farmImagesInputKey, setFarmImagesInputKey] = useState(0);
  const fileInputRefs = useRef({});

  const setFileRef = (name) => (element) => {
    if (element) {
      fileInputRefs.current[name] = element;
    } else {
      delete fileInputRefs.current[name];
    }
  };

  useEffect(() => {
    if (authStatus !== 'authenticated' || !user || user.role !== 'vendor') {
      return;
    }

    let active = true;

    const loadProfile = async () => {
      try {
        const response = await apiFetch('/api/vendor/profile', { method: 'GET' });
        const data = await response.json();
        if (!active) {
          return;
        }
        setProfileApproved(Boolean(data.profileApproved));
        setRequestStatus(typeof data.requestStatus === 'string' ? data.requestStatus : 'not_submitted');
        setRequestReviewNote(
          typeof data?.request?.reviewNote === 'string' ? data.request.reviewNote : '',
        );
        if (data.vendor) {
          setProfile(mapVendorToProfile(data.vendor));
        } else {
          setProfile(initialProfile);
        }
      } catch (error) {
        if (!active) {
          return;
        }
        setProfileStatus({
          state: 'error',
          message: 'Unable to load profile.',
        });
      }
    };

    loadProfile();

    return () => {
      active = false;
    };
  }, [authStatus, user]);

  const handleProfileChange = (event) => {
    const { name, value, type, checked } = event.target;
    setProfile((prev) => ({ ...prev, [name]: type === 'checkbox' ? checked : value }));
  };

  const handleProfileSubmit = async (event) => {
    event.preventDefault();
    setProfileStatus({ state: 'loading', message: 'Saving profile...' });

    try {
      const { id: _id, documents, ...profilePayload } = profile;
      const formData = new FormData();
      
      const payload = {
        ...profilePayload,
        deliveryRadiusKm:
          profile.deliveryRadiusKm === ''
            ? null
            : Number(profile.deliveryRadiusKm),
        farmImages: JSON.stringify(normalizeFarmImages(profile.farmImages)),
      };
      
      for (const [key, value] of Object.entries(payload)) {
        formData.append(key, value);
      }

      const expectedFiles = [];
      if (profile.entityType === 'pf') {
        expectedFiles.push('atestat_prod', 'atestat_prod_2', 'carnet_commerce');
      } else {
        expectedFiles.push('certificat_register', 'cui');
      }

      if (profile.product_oua) expectedFiles.push('sanitary_doc_egg');
      if (profile.product_miere) expectedFiles.push('sanitary_doc_honey');

      for (const name of expectedFiles) {
        const input = fileInputRefs.current[name];
        if (input && input.files && input.files[0]) {
          formData.append(name, input.files[0]);
        } else if (!documents?.[name]) {
          throw new Error(`Please upload ${name.replace(/_/g, ' ')}`);
        }
      }

      const response = await apiFetch('/api/vendor/profile', {
        method: 'POST',
        body: formData,
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Unable to save profile.');
      }
      setProfileApproved(Boolean(data.profileApproved));
      setRequestStatus(typeof data.requestStatus === 'string' ? data.requestStatus : 'pending');
      setRequestReviewNote(
        typeof data?.request?.reviewNote === 'string' ? data.request.reviewNote : '',
      );
      setProfileStatus({
        state: 'success',
        message:
          data.profileApproved
            ? 'Profile saved.'
            : 'Profile request saved. Waiting for admin approval.',
      });
      if (data.vendor) {
        setProfile(mapVendorToProfile(data.vendor));
        setFarmUploadStatus({ state: 'idle', message: '' });
      }
      
      Object.values(fileInputRefs.current).forEach(input => {
        if (input) input.value = '';
      });
    } catch (error) {
      setProfileStatus({
        state: 'error',
        message: error.message || 'Unable to save profile.',
      });
    }
  };

  const handleFarmImagesUpload = async (event) => {
    const files = Array.from(event.target.files || []);
    if (files.length === 0) {
      return;
    }

    const remainingSlots = MAX_FARM_IMAGES - profile.farmImages.length;
    if (remainingSlots <= 0) {
      setFarmUploadStatus({
        state: 'error',
        message: `You can upload up to ${MAX_FARM_IMAGES} farm images.`,
      });
      setFarmImagesInputKey((prev) => prev + 1);
      return;
    }

    const filesToUpload = files.slice(0, remainingSlots);
    setFarmUploadStatus({ state: 'loading', message: 'Uploading farm images...' });

    try {
      const formData = new FormData();
      filesToUpload.forEach((file) => {
        formData.append('photos', file);
      });
      const baseUrl = getApiBase();
      const uploadResponse = await fetch(`${baseUrl}/api/vendor/upload-farm-images`, {
        method: 'POST',
        body: formData,
        credentials: 'include',
      });

      const contentType = uploadResponse.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        const errorText = await uploadResponse.text();
        console.error('Non-JSON response from server:', errorText);
        throw new Error(
          `Server returned non-JSON response (${uploadResponse.status}).`,
        );
      }

      const uploadData = await uploadResponse.json();
      if (!uploadResponse.ok) {
        throw new Error(uploadData.error || 'Failed to upload farm images.');
      }

      const uploadedImages = normalizeFarmImages(uploadData.images);
      if (uploadedImages.length === 0) {
        throw new Error('No farm images were returned by the server.');
      }

      setProfile((prev) => ({
        ...prev,
        farmImages: normalizeFarmImages([...prev.farmImages, ...uploadedImages]),
      }));

      const skippedCount = files.length - filesToUpload.length;
      setFarmUploadStatus({
        state: 'success',
        message:
          skippedCount > 0
            ? `Uploaded ${uploadedImages.length} image(s). ${skippedCount} skipped because the limit is ${MAX_FARM_IMAGES}.`
            : `Uploaded ${uploadedImages.length} image(s).`,
      });
    } catch (error) {
      setFarmUploadStatus({
        state: 'error',
        message: error.message || 'Unable to upload farm images.',
      });
    } finally {
      setFarmImagesInputKey((prev) => prev + 1);
    }
  };

  const handleRemoveFarmImage = (imageIndex) => {
    setProfile((prev) => ({
      ...prev,
      farmImages: prev.farmImages.filter((_, index) => index !== imageIndex),
    }));
  };

  if (authStatus === 'loading') {
    return <div className="notice">Loading vendor dashboard...</div>;
  }

  if (!user || user.role !== 'vendor') {
    return (
      <div className="page-section">
        <h1>Vendor access required</h1>
        <p className="muted">
          Log in with a vendor account to manage your farm profile and products.
        </p>
        <Link className="button primary" to="/auth/login">
          Log in
        </Link>
      </div>
    );
  }

  const effectiveProfileStatus =
    requestStatus === 'pending' || requestStatus === 'rejected'
      ? requestStatus
      : profileApproved
        ? 'approved'
        : requestStatus;

  const statusColor = effectiveProfileStatus === 'approved' ? 'var(--ok)' : effectiveProfileStatus === 'pending' ? 'var(--warn)' : 'inherit';

  return (
    <div className="page-section">
      <div className="section-header">
        <div>
          <h1>Vendor dashboard</h1>
          <p className="muted">
            Welcome back, {user.username}. Profile status:{' '}
            <span style={{ fontWeight: 'bold', color: statusColor, textTransform: 'uppercase' }}>
              {effectiveProfileStatus}
            </span>
          </p>
        </div>
        <div className="button-group">
          {profileApproved && profile.id && (
            <Link className="button ghost" to={`/farms/${profile.id}`}>
              View public page
            </Link>
          )}
          <Link className="button ghost" to="/markets">
            View markets
          </Link>
        </div>
      </div>

      {!profileApproved && (
        <p className="notice">
          Your farm profile is not approved yet. Save profile submits/updates a request in admin review queue.
          Products become available after approval.
        </p>
      )}
      {profileApproved && requestStatus === 'pending' && (
        <p className="notice">
          You already have an approved profile. Your latest changes are pending admin approval.
        </p>
      )}
      {requestStatus === 'rejected' && (
        <p className="notice error" role="alert">
          Your latest profile request was rejected.
          {requestReviewNote ? ` Reason: ${requestReviewNote}` : ''}
          {' '}Update details and save again to resubmit.
        </p>
      )}

      <div className="vendor-grid">
        <form className="form-card" onSubmit={handleProfileSubmit}>
          <h2>Farm profile</h2>
          <label className="field">
            Farm name
            <input
              type="text"
              name="farmName"
              value={profile.farmName}
              onChange={handleProfileChange}
              required
            />
          </label>
          <label className="field">
            Display name
            <input
              type="text"
              name="displayName"
              value={profile.displayName}
              onChange={handleProfileChange}
            />
          </label>
          <div className="field-row">
            <label className="field">
              Street address
              <input
                type="text"
                name="streetAddress"
                value={profile.streetAddress}
                onChange={handleProfileChange}
              />
            </label>
            <label className="field">
              Street number
              <input
                type="text"
                name="streetNumber"
                value={profile.streetNumber}
                onChange={handleProfileChange}
              />
            </label>
          </div>
          <div className="field-row">
            <label className="field">
              County
              <input
                type="text"
                name="county"
                autoComplete="address-level1"
                value={profile.county}
                onChange={handleProfileChange}
              />
            </label>
            <label className="field">
              City
              <input
                type="text"
                name="city"
                autoComplete="address-level2"
                value={profile.city}
                onChange={handleProfileChange}
              />
            </label>
          </div>
          <label className="field">
            Phone number
            <input
              type="tel"
              name="phoneNumber"
              autoComplete="tel"
              value={profile.phoneNumber}
              onChange={handleProfileChange}
            />
          </label>
          <label className="field">
            Email
            <input
              type="email"
              name="email"
              autoComplete="email"
              value={profile.email}
              onChange={handleProfileChange}
            />
          </label>
          <label className="field">
            Organic operator certificate
            <input
              type="text"
              name="organicCertificate"
              value={profile.organicCertificate}
              onChange={handleProfileChange}
              placeholder="Certificate ID or code"
            />
          </label>
          <label className="field">
            Delivery radius (km)
            <input
              type="number"
              name="deliveryRadiusKm"
              min="0"
              step="1"
              value={profile.deliveryRadiusKm}
              onChange={handleProfileChange}
            />
          </label>
          <label className="field">
            Bio
            <textarea
              name="bio"
              rows="3"
              value={profile.bio}
              onChange={handleProfileChange}
            />
          </label>
          
          <fieldset style={{ margin: '1rem 0', padding: '1rem', border: '1px solid var(--line)', borderRadius: '4px' }}>
            <legend style={{ padding: '0 0.5rem', fontWeight: 'bold' }}>Legal Details & Documents</legend>
            <label className="field">
              Entity Type
              <select name="entityType" value={profile.entityType} onChange={handleProfileChange}>
                <option value="pf">Individual (Persoană Fizică)</option>
                <option value="juridica">Legal Entity (PFA/II/SRL)</option>
              </select>
            </label>

            {profile.entityType === 'pf' ? (
              <>
                <label className="field">
                  Producer Certificate - Front {profile.documents?.atestat_prod && <span className="success">(Uploaded)</span>}
                  <input type="file" name="atestat_prod" accept="image/*,.pdf" ref={setFileRef('atestat_prod')} required={!profile.documents?.atestat_prod} />
                </label>
                <label className="field">
                  Producer Certificate - Back {profile.documents?.atestat_prod_2 && <span className="success">(Uploaded)</span>}
                  <input type="file" name="atestat_prod_2" accept="image/*,.pdf" ref={setFileRef('atestat_prod_2')} required={!profile.documents?.atestat_prod_2} />
                </label>
                <label className="field">
                  Commercialization Booklet {profile.documents?.carnet_commerce && <span className="success">(Uploaded)</span>}
                  <input type="file" name="carnet_commerce" accept="image/*,.pdf" ref={setFileRef('carnet_commerce')} required={!profile.documents?.carnet_commerce} />
                </label>
              </>
            ) : (
              <>
                <label className="field">
                  Registration Certificate {profile.documents?.certificat_register && <span className="success">(Uploaded)</span>}
                  <input type="file" name="certificat_register" accept="image/*,.pdf" ref={setFileRef('certificat_register')} required={!profile.documents?.certificat_register} />
                </label>
                <label className="field">
                  Company ID (CUI) {profile.documents?.cui && <span className="success">(Uploaded)</span>}
                  <input type="file" name="cui" accept="image/*,.pdf" ref={setFileRef('cui')} required={!profile.documents?.cui} />
                </label>
              </>
            )}

            <div className="field" style={{ marginTop: '1rem' }}>
              <strong>Product Categories:</strong>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem' }}>
                <input type="checkbox" name="product_oua" checked={profile.product_oua} onChange={handleProfileChange} /> Eggs
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem' }}>
                <input type="checkbox" name="product_miere" checked={profile.product_miere} onChange={handleProfileChange} /> Honey
              </label>
            </div>

            {profile.product_oua && (
              <label className="field">
                Sanitary Registration Document (DSVSA) for Eggs {profile.documents?.sanitary_doc_egg && <span className="success">(Uploaded)</span>}
                <input type="file" name="sanitary_doc_egg" accept="image/*,.pdf" ref={setFileRef('sanitary_doc_egg')} required={!profile.documents?.sanitary_doc_egg} />
              </label>
            )}

            {profile.product_miere && (
              <label className="field">
                Sanitary Registration Document (DSVSA) for Honey {profile.documents?.sanitary_doc_honey && <span className="success">(Uploaded)</span>}
                <input type="file" name="sanitary_doc_honey" accept="image/*,.pdf" ref={setFileRef('sanitary_doc_honey')} required={!profile.documents?.sanitary_doc_honey} />
              </label>
            )}
          </fieldset>

          <label className="field">
            Farm gallery (up to 10 images)
            <input
              key={farmImagesInputKey}
              type="file"
              accept="image/*"
              multiple
              onChange={handleFarmImagesUpload}
              disabled={
                farmUploadStatus.state === 'loading' ||
                profile.farmImages.length >= MAX_FARM_IMAGES
              }
            />
            <p className="muted upload-hint">
              {profile.farmImages.length}/{MAX_FARM_IMAGES} uploaded · JPG, PNG, or
              WebP · max 5MB each.
            </p>
            <div className="farm-gallery-grid">
              {profile.farmImages.length > 0 ? (
                profile.farmImages.map((imageUrl, imageIndex) => (
                  <div className="farm-gallery-thumb" key={`${imageUrl}-${imageIndex}`}>
                    <img
                      src={resolveImageUrl(imageUrl)}
                      alt={`Farm image ${imageIndex + 1}`}
                    />
                    <button
                      className="button ghost small farm-gallery-remove"
                      type="button"
                      onClick={() => handleRemoveFarmImage(imageIndex)}
                    >
                      Remove
                    </button>
                  </div>
                ))
              ) : (
                <div className="upload-placeholder farm-gallery-empty">
                  No farm images uploaded.
                </div>
              )}
            </div>
          </label>
          {farmUploadStatus.message && (
            <p
              className={`notice ${
                farmUploadStatus.state === 'error'
                  ? 'error'
                  : farmUploadStatus.state === 'success'
                    ? 'success'
                    : ''
              }`} role="status"
            >
              {farmUploadStatus.message}
            </p>
          )}
          <button
            className="button primary"
            type="submit"
            disabled={profileStatus.state === 'loading'}
          >
            {profileStatus.state === 'loading' ? 'Saving...' : 'Save profile'}
          </button>
          {profileStatus.message && (
            <p
              className={`notice ${
                profileStatus.state === 'error' ? 'error' : 'success'
              }`} role="status"
            >
              {profileStatus.message}
            </p>
          )}
        </form>
      </div>
    </div>
  );
}
