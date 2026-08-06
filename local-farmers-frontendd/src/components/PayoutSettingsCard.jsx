// The farmer's payout card: Stripe Connect status plus their delivery terms.
//
// This replaces the IBAN field that used to sit here. The platform no longer
// asks for bank details — Stripe collects them during Express onboarding and
// runs the identity checks itself.

import { useCallback, useEffect, useState } from 'react';

import { apiFetch } from '../lib/api.js';

/** Amounts cross the wire as integer bani and are only divided for display. */
const baniToInput = (bani) => {
  if (bani === null || bani === undefined || bani === '') {
    return '';
  }
  const value = Number(bani);
  return Number.isFinite(value) ? (value / 100).toFixed(2) : '';
};

const inputToBani = (value) => {
  if (value === '' || value === null || value === undefined) {
    return null;
  }
  const parsed = Number(String(value).replace(',', '.'));
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : null;
};

const formatBani = (bani) => {
  const value = Number(bani);
  return `${(Number.isFinite(value) ? value / 100 : 0).toFixed(2)} RON`;
};

/** Romanian labels for the requirement keys Stripe returns. */
const REQUIREMENT_LABELS = {
  'individual.verification.document': 'Identity document',
  'individual.id_number': 'CNP',
  'individual.address.line1': 'Address',
  'external_account': 'Bank account (IBAN)',
  'business_profile.url': 'Farm website or page',
  'business_profile.mcc': 'Line of business',
  'tos_acceptance.date': 'Stripe terms acceptance',
};

const describeRequirement = (key) => REQUIREMENT_LABELS[key] || key;

export default function PayoutSettingsCard() {
  const [status, setStatus] = useState(null);
  const [loadState, setLoadState] = useState('loading');
  const [form, setForm] = useState({
    deliveryFee: '',
    minOrderValue: '',
    freeDeliveryThreshold: '',
  });
  const [saveState, setSaveState] = useState({ state: 'idle', message: '' });
  const [linkState, setLinkState] = useState({ state: 'idle', message: '' });

  const applyStatus = useCallback((data) => {
    setStatus(data);
    setForm({
      deliveryFee: baniToInput(data.deliveryFeeBani),
      minOrderValue: baniToInput(data.minOrderValueBani),
      freeDeliveryThreshold: baniToInput(data.freeDeliveryThresholdBani),
    });
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      const response = await apiFetch('/api/connect/status', { method: 'GET' });
      const data = await response.json();
      if (!response.ok) {
        setLoadState(response.status === 404 ? 'not-approved' : 'error');
        return;
      }
      applyStatus(data);
      setLoadState('ready');
    } catch (error) {
      setLoadState('error');
    }
  }, [applyStatus]);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  // Coming back from Stripe's hosted onboarding: re-read the status so the
  // card reflects the new state without waiting for the webhook.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('stripe')) {
      loadStatus();
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, [loadStatus]);

  const openStripe = async (path, busyMessage) => {
    setLinkState({ state: 'loading', message: busyMessage });
    try {
      const response = await apiFetch(path, { method: 'POST', body: JSON.stringify({}) });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Stripe did not respond.');
      }
      window.location.href = data.url;
    } catch (error) {
      setLinkState({ state: 'error', message: error.message || 'Stripe did not respond.' });
    }
  };

  const handleSave = async (event) => {
    event.preventDefault();
    setSaveState({ state: 'loading', message: 'Saving...' });

    try {
      const response = await apiFetch('/api/connect/payout-settings', {
        method: 'PUT',
        body: JSON.stringify({
          deliveryFeeBani: inputToBani(form.deliveryFee) ?? 0,
          minOrderValueBani: inputToBani(form.minOrderValue) ?? 0,
          freeDeliveryThresholdBani: inputToBani(form.freeDeliveryThreshold),
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Could not save your settings.');
      }
      applyStatus(data);
      setSaveState({ state: 'success', message: 'Delivery terms saved.' });
    } catch (error) {
      setSaveState({ state: 'error', message: error.message || 'Could not save your settings.' });
    }
  };

  if (loadState === 'loading') {
    return (
      <section className="profile-card">
        <header className="profile-card-head">
          <h2>Payouts</h2>
        </header>
        <div className="profile-card-body">
          <p className="muted">Loading your payout account status...</p>
        </div>
      </section>
    );
  }

  if (loadState === 'not-approved') {
    return (
      <section className="profile-card">
        <header className="profile-card-head">
          <h2>Payouts</h2>
          <p className="profile-card-sub">Available once your farm is approved.</p>
        </header>
        <div className="profile-card-body">
          <p className="muted">
            Payout setup opens once an admin approves your farm. We never ask for your IBAN
            here — Stripe collects it directly from you when you reach that step.
          </p>
        </div>
      </section>
    );
  }

  if (loadState === 'error' || !status) {
    return (
      <section className="profile-card">
        <header className="profile-card-head">
          <h2>Payouts</h2>
        </header>
        <div className="profile-card-body">
          <p className="notice error" role="alert">
            Could not load your payout account status. Please reload the page.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="profile-card">
      <header className="profile-card-head">
        <h2>Payouts</h2>
        <p className="profile-card-sub">
          Money reaches you right after each paid order, straight into your own Stripe account.
        </p>
      </header>

      <div className="profile-card-body">
        {/* The one thing that decides whether this farm is in the market. */}
        <div className={`payout-status is-${status.canSell ? 'active' : 'blocked'}`}>
          <p className="payout-status-title">
            {status.canSell ? 'Your payout account is active' : 'Your products are not visible yet'}
          </p>
          <p className="payout-status-hint">{status.hint}</p>
        </div>

        {!status.canSell && (
          <p className="notice error" role="alert">
            While your payout account is inactive, your products do not appear in the shop and
            cannot be added to a basket. They stay saved in your account and come back
            automatically the moment Stripe confirms your verification.
          </p>
        )}

        {status.requirementsDue?.length > 0 && (
          <div className="payout-requirements">
            <p className="payout-requirements-title">Stripe still needs:</p>
            <ul>
              {status.requirementsDue.map((item) => (
                <li key={item}>{describeRequirement(item)}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="payout-actions">
          <button
            type="button"
            className="button primary"
            disabled={linkState.state === 'loading'}
            onClick={() => openStripe('/api/connect/onboard', 'Opening Stripe...')}
          >
            {!status.connected
              ? 'Set up payouts'
              : status.detailsSubmitted && status.requirementsDue.length === 0
                ? 'Update your details at Stripe'
                : 'Continue setup'}
          </button>

          {status.connected && status.detailsSubmitted && (
            <button
              type="button"
              className="button ghost"
              disabled={linkState.state === 'loading'}
              onClick={() => openStripe('/api/connect/dashboard', 'Opening your Stripe dashboard...')}
            >
              Open Stripe dashboard
            </button>
          )}
        </div>

        {linkState.state === 'error' && (
          <p className="notice error" role="alert">
            {linkState.message}
          </p>
        )}

        <p className="profile-hint">
          We never ask for your IBAN anywhere on Farmables. Stripe collects it directly from you,
          verifies your identity, and pays the money into your account. We neither see nor store
          your bank details.
        </p>

        <hr className="profile-divider" />

        {/* LOG-02 — the terms the farmer sets for their own sub-cart. */}
        <form className="payout-settings-form" onSubmit={handleSave}>
          <h3 className="payout-settings-title">Delivery and minimum order</h3>

          {!status.payoutSettingsSet && (
            <p className="notice" role="status">
              You have not set your delivery terms yet. Customers currently see free delivery and no
              minimum order — set the values that work for you.
            </p>
          )}

          <div className="profile-fields">
            <label className="field">
              Delivery fee (RON)
              <input
                type="number"
                min="0"
                step="0.01"
                value={form.deliveryFee}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, deliveryFee: event.target.value }))
                }
                placeholder="0.00"
              />
              <span className="field-hint">
                Charged once per order, however many of your products the customer buys.
              </span>
            </label>

            <label className="field">
              Minimum order (RON)
              <input
                type="number"
                min="0"
                step="0.01"
                value={form.minOrderValue}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, minOrderValue: event.target.value }))
                }
                placeholder="0.00"
              />
              <span className="field-hint">
                Below this value the customer cannot check out with your products. 0 means no minimum.
              </span>
            </label>

            <label className="field">
              Free delivery above (RON)
              <input
                type="number"
                min="0"
                step="0.01"
                value={form.freeDeliveryThreshold}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, freeDeliveryThreshold: event.target.value }))
                }
                placeholder="Optional"
              />
              <span className="field-hint">
                Leave empty if the delivery fee always applies.
              </span>
            </label>
          </div>

          <p className="profile-hint">
            From every order you receive <strong>the products plus your delivery fee</strong>. The
            platform fee is paid separately by the customer, on top of your prices — it is not
            deducted from your money.
            {status.deliveryFeeBani > 0 && (
              <>
                {' '}
                At your current settings, a 100.00 RON order brings you{' '}
                {formatBani(10000 + status.deliveryFeeBani)}.
              </>
            )}
          </p>

          {saveState.message && (
            <p
              className={`notice ${saveState.state === 'error' ? 'error' : 'success'}`}
              role={saveState.state === 'error' ? 'alert' : 'status'}
            >
              {saveState.message}
            </p>
          )}

          <button type="submit" className="button primary" disabled={saveState.state === 'loading'}>
            {saveState.state === 'loading' ? 'Saving...' : 'Save delivery terms'}
          </button>
        </form>
      </div>
    </section>
  );
}
