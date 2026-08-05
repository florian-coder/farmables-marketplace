import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { apiFetch, resolveImageUrl } from '../lib/api.js';

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
      const haystack = [
        vendor.farmName,
        vendor.displayName,
        vendor.city,
        vendor.county,
        vendor.phoneNumber,
        vendor.email,
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

      <div className="farmers-toolbar form-card">
        <label className="field">
          Search farmers
          <input
            type="text"
            placeholder="Search by farm name, city, county, or phone"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>

      {state.status === 'loading' && <div className="notice">Loading farmers...</div>}
      {state.status === 'error' && <div className="notice error" role="alert">{state.error}</div>}

      {state.status === 'success' && (
        <div className="farmers-grid">
          {filteredVendors.length > 0 ? (
            filteredVendors.map((vendor) => {
              const coverImage = vendor.farmImages?.[0] || null;
              return (
                <Link className="farmer-card" key={vendor.id} to={`/farms/${vendor.id}`}>
                  <div className="farmer-card-image">
                    {coverImage ? (
                      <img
                        src={resolveImageUrl(coverImage)}
                        alt={`${vendor.farmName || vendor.displayName} cover`}
                      />
                    ) : (
                      <span>
                        {(vendor.farmName || vendor.displayName || '?')
                          .charAt(0)
                          .toUpperCase()}
                      </span>
                    )}
                  </div>
                  <div className="farmer-card-content">
                    <h2>{vendor.farmName || 'Unnamed farm'}</h2>
                    <p className="muted">
                      {vendor.displayName || 'No display name'}
                    </p>
                    <p className="muted">
                      {[vendor.city, vendor.county].filter(Boolean).join(', ') ||
                        'Location not provided'}
                    </p>
                    <p className="muted">
                      Email: {vendor.email || 'Not provided'}
                    </p>
                    <p className="muted">
                      Rating:{' '}
                      {vendor.vendorRating !== null &&
                      vendor.vendorRating !== undefined
                        ? `${vendor.vendorRating} stars`
                        : 'N/A stars'}
                    </p>
                    <p className="muted">
                      {vendor.productCount || 0} product
                      {vendor.productCount === 1 ? '' : 's'}
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
