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
  return `${(Number.isFinite(value) ? value / 100 : 0).toFixed(2).replace('.', ',')} lei`;
};

/** Romanian labels for the requirement keys Stripe returns. */
const REQUIREMENT_LABELS = {
  'individual.verification.document': 'Act de identitate',
  'individual.id_number': 'CNP',
  'individual.address.line1': 'Adresa',
  'external_account': 'Cont bancar (IBAN)',
  'business_profile.url': 'Site sau pagină a fermei',
  'business_profile.mcc': 'Domeniul de activitate',
  'tos_acceptance.date': 'Acceptarea termenilor Stripe',
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
        throw new Error(data.error || 'Stripe nu a răspuns.');
      }
      window.location.href = data.url;
    } catch (error) {
      setLinkState({ state: 'error', message: error.message || 'Stripe nu a răspuns.' });
    }
  };

  const handleSave = async (event) => {
    event.preventDefault();
    setSaveState({ state: 'loading', message: 'Salvăm...' });

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
        throw new Error(data.error || 'Nu am putut salva setările.');
      }
      applyStatus(data);
      setSaveState({ state: 'success', message: 'Setările de livrare au fost salvate.' });
    } catch (error) {
      setSaveState({ state: 'error', message: error.message || 'Nu am putut salva setările.' });
    }
  };

  if (loadState === 'loading') {
    return (
      <section className="profile-card">
        <header className="profile-card-head">
          <h2>Plăți</h2>
        </header>
        <div className="profile-card-body">
          <p className="muted">Se încarcă starea contului de plată...</p>
        </div>
      </section>
    );
  }

  if (loadState === 'not-approved') {
    return (
      <section className="profile-card">
        <header className="profile-card-head">
          <h2>Plăți</h2>
          <p className="profile-card-sub">Disponibil după aprobarea fermei.</p>
        </header>
        <div className="profile-card-body">
          <p className="muted">
            Configurarea plăților se deschide după ce un administrator îți aprobă ferma. Nu îți
            cerem IBAN-ul aici — îl colectează Stripe, direct de la tine, când ajungi la pasul ăla.
          </p>
        </div>
      </section>
    );
  }

  if (loadState === 'error' || !status) {
    return (
      <section className="profile-card">
        <header className="profile-card-head">
          <h2>Plăți</h2>
        </header>
        <div className="profile-card-body">
          <p className="notice error" role="alert">
            Nu am putut încărca starea contului de plată. Reîncarcă pagina.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="profile-card">
      <header className="profile-card-head">
        <h2>Plăți</h2>
        <p className="profile-card-sub">
          Banii ajung la tine imediat după fiecare comandă plătită, direct în contul tău Stripe.
        </p>
      </header>

      <div className="profile-card-body">
        {/* The one thing that decides whether this farm is in the market. */}
        <div className={`payout-status is-${status.canSell ? 'active' : 'blocked'}`}>
          <p className="payout-status-title">
            {status.canSell ? 'Contul de plată este activ' : 'Produsele tale nu sunt încă vizibile'}
          </p>
          <p className="payout-status-hint">{status.hint}</p>
        </div>

        {!status.canSell && (
          <p className="notice error" role="alert">
            Cât timp contul de plată nu e activ, produsele tale nu apar în magazin și nu pot fi
            adăugate în coș. Rămân salvate în contul tău și reapar automat în momentul în care
            Stripe confirmă verificarea.
          </p>
        )}

        {status.requirementsDue?.length > 0 && (
          <div className="payout-requirements">
            <p className="payout-requirements-title">Stripe mai are nevoie de:</p>
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
            onClick={() => openStripe('/api/connect/onboard', 'Deschidem Stripe...')}
          >
            {!status.connected
              ? 'Configurează plățile'
              : status.detailsSubmitted && status.requirementsDue.length === 0
                ? 'Actualizează datele la Stripe'
                : 'Continuă configurarea'}
          </button>

          {status.connected && status.detailsSubmitted && (
            <button
              type="button"
              className="button ghost"
              disabled={linkState.state === 'loading'}
              onClick={() => openStripe('/api/connect/dashboard', 'Deschidem panoul Stripe...')}
            >
              Deschide panoul Stripe
            </button>
          )}
        </div>

        {linkState.state === 'error' && (
          <p className="notice error" role="alert">
            {linkState.message}
          </p>
        )}

        <p className="profile-hint">
          Nu îți cerem IBAN-ul nicăieri pe Farmables. Stripe îl colectează direct de la tine, îți
          verifică identitatea și tot el îți trimite banii în cont. Noi nu vedem și nu stocăm datele
          tale bancare.
        </p>

        <hr className="profile-divider" />

        {/* LOG-02 — the terms the farmer sets for their own sub-cart. */}
        <form className="payout-settings-form" onSubmit={handleSave}>
          <h3 className="payout-settings-title">Livrare și comandă minimă</h3>

          {!status.payoutSettingsSet && (
            <p className="notice" role="status">
              Nu ți-ai setat încă termenii de livrare. Clienții văd acum livrare gratuită și fără
              comandă minimă — setează valorile care ți se potrivesc.
            </p>
          )}

          <div className="profile-fields">
            <label className="field">
              Taxă de livrare (lei)
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
                Se adaugă o singură dată per comandă, oricâte produse ar cumpăra clientul de la
                tine.
              </span>
            </label>

            <label className="field">
              Comandă minimă (lei)
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
                Sub această valoare, clientul nu poate finaliza comanda de la tine. 0 înseamnă fără
                minim.
              </span>
            </label>

            <label className="field">
              Livrare gratuită peste (lei)
              <input
                type="number"
                min="0"
                step="0.01"
                value={form.freeDeliveryThreshold}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, freeDeliveryThreshold: event.target.value }))
                }
                placeholder="Opțional"
              />
              <span className="field-hint">
                Lasă gol dacă taxa de livrare se aplică întotdeauna.
              </span>
            </label>
          </div>

          <p className="profile-hint">
            Din fiecare comandă primești <strong>produsele + taxa de livrare</strong>. Comisionul
            platformei este plătit separat de client, peste prețurile tale — nu se scade din banii
            tăi.
            {status.deliveryFeeBani > 0 && (
              <>
                {' '}
                La setările actuale, o comandă de 100,00 lei îți aduce{' '}
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
            {saveState.state === 'loading' ? 'Se salvează...' : 'Salvează termenii de livrare'}
          </button>
        </form>
      </div>
    </section>
  );
}
