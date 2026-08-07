import { useEffect, useState, useRef } from 'react';
import { Link } from 'react-router-dom';

import { apiFetch, getApiBase, resolveImageUrl } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import PasswordChangeCard from '../components/PasswordChangeCard.jsx';
import PrivacyCard from '../components/PrivacyCard.jsx';
import PayoutSettingsCard from '../components/PayoutSettingsCard.jsx';

const MAX_FARM_IMAGES = 10;

const STATUS_META = {
  approved: {
    label: 'Approved',
    note: 'Your farm is live in the markets.',
  },
  pending: {
    label: 'Waiting for review',
    note: 'An admin checks your details before your products go live.',
  },
  rejected: {
    label: 'Changes requested',
    note: 'Update the details below and save again to resubmit.',
  },
  not_submitted: {
    label: 'Not submitted',
    note: 'Fill in the form and save. An admin reviews your farm before your products go live.',
  },
};

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

/** Un document încărcat arată la fel oriunde: etichetă, stare, câmp de fișier. */
function DocumentField({ label, name, uploaded, inputRef }) {
  return (
    <label className="profile-doc">
      <span className="profile-doc-head">
        <span className="profile-doc-label">{label}</span>
        <span className={`profile-doc-state ${uploaded ? 'is-uploaded' : ''}`}>
          {uploaded ? 'Uploaded' : 'Required'}
        </span>
      </span>
      <input
        type="file"
        name={name}
        accept="image/*,.pdf"
        ref={inputRef}
        required={!uploaded}
      />
      {uploaded && (
        <span className="profile-doc-hint">Pick a file only if you want to replace it.</span>
      )}
    </label>
  );
}

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
    return <div className="notice">Loading farm profile...</div>;
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

  const statusMeta = STATUS_META[effectiveProfileStatus] || STATUS_META.not_submitted;
  const statusNote =
    effectiveProfileStatus === 'rejected'
      ? `${requestReviewNote ? `Reason: ${requestReviewNote}. ` : ''}${statusMeta.note}`
      : profileApproved && requestStatus === 'pending'
        ? 'Your farm stays live while an admin reviews the latest changes.'
        : statusMeta.note;

  const galleryFull = profile.farmImages.length >= MAX_FARM_IMAGES;
  const galleryBusy = farmUploadStatus.state === 'loading';

  return (
    <div className="page-section">
      <div className="section-header">
        <div>
          <h1>Farm profile</h1>
          <p className="muted">
            Everything customers see about your farm, and where the money lands at the end of the
            month.
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

      <div className={`profile-status-bar is-${effectiveProfileStatus}`}>
        <span className="profile-status-pill">{statusMeta.label}</span>
        <p className="profile-status-note">{statusNote}</p>
      </div>

      <form className="profile-form" onSubmit={handleProfileSubmit}>
        <section className="profile-card">
          <header className="profile-card-head">
            <h2>Farm identity</h2>
            <p className="profile-card-sub">The name and the story customers meet first.</p>
          </header>
          <div className="profile-card-body">
            <div className="profile-fields">
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
              <label className="field is-wide">
                Bio
                <textarea
                  name="bio"
                  rows="4"
                  value={profile.bio}
                  onChange={handleProfileChange}
                />
              </label>
            </div>
          </div>
        </section>

        <section className="profile-card">
          <header className="profile-card-head">
            <h2>Location &amp; contact</h2>
            <p className="profile-card-sub">
              How far you deliver and how customers reach you.
            </p>
          </header>
          <div className="profile-card-body">
            <div className="profile-fields">
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
            </div>
          </div>
        </section>

        <section className="profile-card">
          <header className="profile-card-head">
            <h2>Certification &amp; documents</h2>
            <p className="profile-card-sub">
              Checked once by an admin, before your products go live.
            </p>
          </header>
          <div className="profile-card-body">
            <div className="profile-fields">
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
                Entity type
                <select
                  name="entityType"
                  value={profile.entityType}
                  onChange={handleProfileChange}
                >
                  <option value="pf">Individual producer</option>
                  <option value="juridica">Registered business (PFA / II / SRL)</option>
                </select>
              </label>
            </div>

            <div className="profile-docs">
              {profile.entityType === 'pf' ? (
                <>
                  <DocumentField
                    label="Producer certificate — front"
                    name="atestat_prod"
                    uploaded={Boolean(profile.documents?.atestat_prod)}
                    inputRef={setFileRef('atestat_prod')}
                  />
                  <DocumentField
                    label="Producer certificate — back"
                    name="atestat_prod_2"
                    uploaded={Boolean(profile.documents?.atestat_prod_2)}
                    inputRef={setFileRef('atestat_prod_2')}
                  />
                  <DocumentField
                    label="Commercialization booklet"
                    name="carnet_commerce"
                    uploaded={Boolean(profile.documents?.carnet_commerce)}
                    inputRef={setFileRef('carnet_commerce')}
                  />
                </>
              ) : (
                <>
                  <DocumentField
                    label="Registration certificate"
                    name="certificat_register"
                    uploaded={Boolean(profile.documents?.certificat_register)}
                    inputRef={setFileRef('certificat_register')}
                  />
                  <DocumentField
                    label="Company ID (CUI)"
                    name="cui"
                    uploaded={Boolean(profile.documents?.cui)}
                    inputRef={setFileRef('cui')}
                  />
                </>
              )}
            </div>

            <fieldset className="profile-categories">
              <legend>Product categories</legend>
              <div className="profile-toggles">
                <label className="profile-toggle">
                  <input
                    type="checkbox"
                    name="product_oua"
                    checked={profile.product_oua}
                    onChange={handleProfileChange}
                  />
                  Eggs
                </label>
                <label className="profile-toggle">
                  <input
                    type="checkbox"
                    name="product_miere"
                    checked={profile.product_miere}
                    onChange={handleProfileChange}
                  />
                  Honey
                </label>
              </div>
            </fieldset>

            {(profile.product_oua || profile.product_miere) && (
              <div className="profile-docs">
                {profile.product_oua && (
                  <DocumentField
                    label="Sanitary registration (DSVSA) — eggs"
                    name="sanitary_doc_egg"
                    uploaded={Boolean(profile.documents?.sanitary_doc_egg)}
                    inputRef={setFileRef('sanitary_doc_egg')}
                  />
                )}
                {profile.product_miere && (
                  <DocumentField
                    label="Sanitary registration (DSVSA) — honey"
                    name="sanitary_doc_honey"
                    uploaded={Boolean(profile.documents?.sanitary_doc_honey)}
                    inputRef={setFileRef('sanitary_doc_honey')}
                  />
                )}
              </div>
            )}
          </div>
        </section>

        <section className="profile-card">
          <header className="profile-card-head">
            <h2>Farm gallery</h2>
            <p className="profile-card-sub">
              Up to {MAX_FARM_IMAGES} photos. The first one becomes the cover.
            </p>
          </header>
          <div className="profile-card-body">
            <label className={`profile-upload ${galleryFull || galleryBusy ? 'is-disabled' : ''}`}>
              <input
                key={farmImagesInputKey}
                className="visually-hidden"
                type="file"
                accept="image/*"
                multiple
                onChange={handleFarmImagesUpload}
                disabled={galleryBusy || galleryFull}
              />
              <span className="profile-upload-title">
                {galleryFull ? 'Gallery is full' : galleryBusy ? 'Uploading...' : 'Add photos'}
              </span>
              <span className="profile-upload-hint">
                {profile.farmImages.length}/{MAX_FARM_IMAGES} uploaded · JPG, PNG or WebP · max 5MB
                each
              </span>
            </label>

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
          </div>
        </section>

        <div className="profile-actions">
          <div className="profile-actions-text">
            {profileStatus.message ? (
              <p
                className={`notice ${
                  profileStatus.state === 'error' ? 'error' : 'success'
                }`} role="status"
              >
                {profileStatus.message}
              </p>
            ) : (
              <p className="profile-actions-hint">
                Saving sends your profile to the admin review queue.
              </p>
            )}
          </div>
          <button
            className="button primary"
            type="submit"
            disabled={profileStatus.state === 'loading'}
          >
            {profileStatus.state === 'loading' ? 'Saving...' : 'Save profile'}
          </button>
        </div>
      </form>

      {/* Outside the profile form on purpose: payouts have their own form and
          their own save button, and saving one must not submit the other. */}
      <PayoutSettingsCard />

      <PasswordChangeCard />
      <PrivacyCard />
    </div>
  );
}
