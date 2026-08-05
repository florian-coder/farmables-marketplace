import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { apiFetch, resolveImageUrl } from '../lib/api.js';

const SearchIcon = () => (
  <svg
    className="search-icon"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <circle cx="11" cy="11" r="8" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
);

const initialState = {
  status: 'loading',
  vendors: [],
  error: '',
};

export default function FarmersPage() {
  const [state, setState] = useState(initialState);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let active = true;

    const loadFarmers = async () => {
      try {
        const response = await apiFetch('/api/vendors', { method: 'GET' });
        const data = await response.json();
        if (!active) {
          return;
        }
        if (!response.ok) {
          throw new Error(data.error || 'Unable to load farmers.');
        }

        setState({
          status: 'success',
          vendors: data.vendors || [],
          error: '',
        });
      } catch (error) {
        if (!active) {
          return;
        }
        setState({
          status: 'error',
          vendors: [],
          error: error.message || 'Unable to load farmers.',
        });
      }
    };

    loadFarmers();

    return () => {
      active = false;
    };
  }, []);

  const filteredVendors = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return state.vendors;
    }
    return state.vendors.filter((vendor) => {
      // Emailul și telefonul nu se caută aici: nu sunt afișate în listă,
      // iar căutarea după un câmp invizibil scurge date de contact.
      const haystack = [
        vendor.farmName,
        vendor.displayName,
        vendor.city,
        vendor.county,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [query, state.vendors]);

  return (
    <div className="page-section">
      <div className="section-header">
        <div>
          <h1>Farmers</h1>
          <p className="muted">
            Browse all farm profiles and open any card for full details.
          </p>
        </div>
      </div>

      <div className="farmers-toolbar">
        <div className="search-input-wrapper">
          <label className="field">
            Search farmers
            <span className="search-field">
              <SearchIcon />
              <input
                type="text"
                placeholder="Search by farm name, city, or county"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </span>
          </label>
        </div>
      </div>

      {state.status === 'loading' && <div className="notice">Loading farmers...</div>}
      {state.status === 'error' && <div className="notice error" role="alert">{state.error}</div>}

      {state.status === 'success' && (
        <div className="farmers-grid">
          {filteredVendors.length > 0 ? (
            filteredVendors.map((vendor) => {
              const coverImage = vendor.farmImages?.[0] || null;
              const name = vendor.farmName || vendor.displayName || 'Unnamed farm';
              const place = [vendor.city, vendor.county].filter(Boolean).join(', ');
              const count = vendor.productCount || 0;

              return (
                <Link className="farmer-card" key={vendor.id} to={`/farms/${vendor.id}`}>
                  <div className="farmer-card-image">
                    {coverImage ? (
                      <img
                        src={resolveImageUrl(coverImage)}
                        alt={`${name} cover`}
                        loading="lazy"
                      />
                    ) : (
                      <span aria-hidden="true">{name.charAt(0).toUpperCase()}</span>
                    )}
                  </div>
                  <div className="farmer-card-content">
                    <h2>{name}</h2>
                    <p className="farmer-card-place">
                      {place || 'Location not provided'}
                    </p>
                    <p className="farmer-card-stats">
                      {vendor.vendorRating !== null && vendor.vendorRating !== undefined && (
                        <span className="farmer-card-rating">
                          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                          </svg>
                          {Number(vendor.vendorRating).toFixed(1)}
                        </span>
                      )}
                      <span className="farmer-card-count">
                        {count} product{count === 1 ? '' : 's'}
                      </span>
                    </p>
                  </div>
                </Link>
              );
            })
          ) : (
            <p className="muted">No farmers match your search.</p>
          )}
        </div>
      )}
    </div>
  );
}
