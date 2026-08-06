import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { apiFetch } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import PasswordChangeCard from '../components/PasswordChangeCard.jsx';

const initialProfile = {
  firstName: '',
  lastName: '',
  streetAddress: '',
  streetNumber: '',
  phoneNumber: '',
  email: '',
  city: '',
  country: '',
  county: '',
};

/** Toate sunt cerute de API la salvare, deci le numărăm pe cele goale. */
const REQUIRED_FIELDS = Object.keys(initialProfile);

const mapProfile = (profile) => ({
  firstName: profile?.firstName || '',
  lastName: profile?.lastName || '',
  streetAddress: profile?.streetAddress || '',
  streetNumber: profile?.streetNumber || '',
  phoneNumber: profile?.phoneNumber || '',
  email: profile?.email || '',
  city: profile?.city || '',
  country: profile?.country || '',
  county: profile?.county || '',
});

export default function CustomerProfilePage() {
  const { status: authStatus, user } = useAuth();
  const [profile, setProfile] = useState(initialProfile);
  const [profileStatus, setProfileStatus] = useState({
    state: 'loading',
    message: '',
  });

  useEffect(() => {
    if (authStatus !== 'authenticated' || !user || user.role !== 'customer') {
      return;
    }

    let active = true;
    const loadProfile = async () => {
      setProfileStatus({ state: 'loading', message: 'Loading profile...' });
      try {
        const response = await apiFetch('/api/profile', { method: 'GET' });
        const data = await response.json();
        if (!active) {
          return;
        }
        if (!response.ok) {
          throw new Error(data.error || 'Unable to load profile.');
        }

        setProfile(mapProfile(data.profile));
        setProfileStatus({ state: 'idle', message: '' });
      } catch (error) {
        if (!active) {
          return;
        }
        setProfileStatus({
          state: 'error',
          message: error.message || 'Unable to load profile.',
        });
      }
    };

    loadProfile();

    return () => {
      active = false;
    };
  }, [authStatus, user]);

  const handleChange = (event) => {
    const { name, value } = event.target;
    setProfile((prev) => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setProfileStatus({ state: 'loading', message: 'Saving profile...' });

    try {
      const response = await apiFetch('/api/profile', {
        method: 'POST',
        body: JSON.stringify(profile),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Unable to save profile.');
      }

      setProfile(mapProfile(data.profile));
      setProfileStatus({ state: 'success', message: 'Profile saved.' });
    } catch (error) {
      setProfileStatus({
        state: 'error',
        message: error.message || 'Unable to save profile.',
      });
    }
  };

  if (authStatus === 'loading') {
    return <div className="notice">Loading profile...</div>;
  }

  if (!user) {
    return (
      <div className="page-section">
        <h1>Profile access required</h1>
        <p className="muted">Log in to manage your profile details.</p>
        <Link className="button primary" to="/auth/login">
          Log in
        </Link>
      </div>
    );
  }

  if (user.role !== 'customer') {
    return (
      <div className="page-section">
        <h1>Customer profile</h1>
        <p className="muted">This page is available only for customer accounts.</p>
      </div>
    );
  }

  const missingCount = REQUIRED_FIELDS.filter(
    (field) => !String(profile[field] || '').trim(),
  ).length;
  const isComplete = missingCount === 0;
  const isLoadingProfile = profileStatus.state === 'loading';

  return (
    <div className="page-section">
      <div className="section-header">
        <div>
          <h1>My profile</h1>
          <p className="muted">
            Where your baskets are delivered, and how the farmers reach you.
          </p>
        </div>
        <div className="button-group">
          <Link className="button ghost" to="/orders">
            Your orders
          </Link>
          <Link className="button ghost" to="/markets">
            Browse markets
          </Link>
        </div>
      </div>

      {!isLoadingProfile && (
        <div className={`profile-status-bar ${isComplete ? 'is-complete' : 'is-incomplete'}`}>
          <span className="profile-status-pill">
            {isComplete ? 'Complete' : `${missingCount} to fill in`}
          </span>
          <p className="profile-status-note">
            {isComplete
              ? 'Your details are complete — orders can be delivered.'
              : 'Farmers need every field filled in before they can deliver your order.'}
          </p>
        </div>
      )}

      <form className="profile-form" onSubmit={handleSubmit}>
        <section className="profile-card">
          <header className="profile-card-head">
            <h2>Who you are</h2>
            <p className="profile-card-sub">
              The name and contact the farmer sees on your order.
            </p>
          </header>
          <div className="profile-card-body">
            <div className="profile-fields">
              <label className="field">
                Name
                <input
                  type="text"
                  name="firstName"
                  autoComplete="given-name"
                  value={profile.firstName}
                  onChange={handleChange}
                  required
                />
              </label>
              <label className="field">
                Surname
                <input
                  type="text"
                  name="lastName"
                  autoComplete="family-name"
                  value={profile.lastName}
                  onChange={handleChange}
                  required
                />
              </label>
              <label className="field">
                Phone number
                <input
                  type="tel"
                  name="phoneNumber"
                  autoComplete="tel"
                  value={profile.phoneNumber}
                  onChange={handleChange}
                  required
                />
              </label>
              <label className="field">
                Email
                <input
                  type="email"
                  name="email"
                  autoComplete="email"
                  value={profile.email}
                  onChange={handleChange}
                  required
                />
              </label>
            </div>
          </div>
        </section>

        <section className="profile-card">
          <header className="profile-card-head">
            <h2>Delivery address</h2>
            <p className="profile-card-sub">Where the basket is dropped off.</p>
          </header>
          <div className="profile-card-body">
            <div className="profile-fields">
              <label className="field">
                Address street
                <input
                  type="text"
                  name="streetAddress"
                  autoComplete="address-line1"
                  value={profile.streetAddress}
                  onChange={handleChange}
                  required
                />
              </label>
              <label className="field">
                Address number
                <input
                  type="text"
                  name="streetNumber"
                  autoComplete="address-line2"
                  value={profile.streetNumber}
                  onChange={handleChange}
                  required
                />
              </label>
              <label className="field">
                City
                <input
                  type="text"
                  name="city"
                  autoComplete="address-level2"
                  value={profile.city}
                  onChange={handleChange}
                  required
                />
              </label>
              <label className="field">
                County
                <input
                  type="text"
                  name="county"
                  autoComplete="address-level1"
                  value={profile.county}
                  onChange={handleChange}
                  required
                />
              </label>
              <label className="field is-wide">
                Country
                <input
                  type="text"
                  name="country"
                  autoComplete="country-name"
                  value={profile.country}
                  onChange={handleChange}
                  required
                />
              </label>
            </div>
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
                Your address is shared only with the farms you order from.
              </p>
            )}
          </div>
          <button className="button primary" type="submit" disabled={isLoadingProfile}>
            {isLoadingProfile ? 'Saving...' : 'Save profile'}
          </button>
        </div>
      </form>

      <PasswordChangeCard />
    </div>
  );
}
