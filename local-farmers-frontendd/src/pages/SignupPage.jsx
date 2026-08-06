import { Suspense, lazy, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { apiFetch } from '../lib/api.js';
import { reconcileVersions, signupDocumentFor } from '../lib/legal.js';

// Loaded only when the reader actually opens the text, so the Markdown
// renderer never lands in the signup bundle.
const LegalDocument = lazy(() => import('../components/LegalDocument.jsx'));

const initialForm = {
  username: '',
  email: '',
  password: '',
  role: 'customer',
};

export default function SignupPage() {
  const [searchParams] = useSearchParams();
  const [form, setForm] = useState(initialForm);
  const [status, setStatus] = useState({ state: 'idle', message: '' });
  // LEG-02/LEG-03 — unticked by default, always. Pre-ticking a consent box is
  // not consent (Art. 4(11) GDPR, and Planet49, C-673/17).
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [termsOpen, setTermsOpen] = useState(false);
  const [registry, setRegistry] = useState(null);

  // Which document applies depends on the role being registered: producers
  // sign a B2B agreement, customers a consumer one.
  const legalDocument = signupDocumentFor(form.role);
  const versionCheck = registry ? reconcileVersions(legalDocument, registry) : null;

  useEffect(() => {
    const role = searchParams.get('role');
    if (role === 'vendor' || role === 'customer') {
      setForm((prev) => ({ ...prev, role }));
    }
  }, [searchParams]);

  useEffect(() => {
    let active = true;
    apiFetch('/api/legal/documents', { method: 'GET' })
      .then((response) => response.json())
      .then((data) => {
        if (active && Array.isArray(data.documents)) {
          setRegistry(data.documents);
        }
      })
      .catch(() => {
        // Leaving `registry` null keeps the form usable; the server revalidates
        // the version on submit anyway, so a failed fetch cannot let a stale
        // consent through.
      });
    return () => {
      active = false;
    };
  }, []);

  // Switching role switches the contract, so a tick given for one document
  // must not carry over to the other.
  useEffect(() => {
    setTermsAccepted(false);
    setTermsOpen(false);
  }, [form.role]);

  const handleChange = (event) => {
    const { name, value } = event.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();

    if (!termsAccepted) {
      setStatus({
        state: 'error',
        message: 'Trebuie să accepți termenii și condițiile ca să îți creezi cont.',
      });
      return;
    }
    if (versionCheck && !versionCheck.ok) {
      setStatus({
        state: 'error',
        message: 'Termenii afișați nu sunt cei în vigoare. Reîncarcă pagina.',
      });
      return;
    }

    setStatus({ state: 'loading', message: 'Se creează contul...' });

    try {
      const response = await apiFetch('/api/auth/signup', {
        method: 'POST',
        body: JSON.stringify({
          ...form,
          // The version travels with the consent: a record that does not name
          // the version proves nothing once the text changes.
          acceptedDocuments: [{ key: legalDocument.key, version: legalDocument.version }],
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Înregistrarea a eșuat.');
      }

      setStatus({
        state: 'success',
        message: 'Cont creat. Verifică-ți emailul, apoi te poți autentifica.',
      });
      setForm((prev) => ({ ...prev, password: '' }));
      setTermsAccepted(false);
    } catch (error) {
      setStatus({
        state: 'error',
        message: error.message || 'Înregistrarea a eșuat.',
      });
    }
  };

  return (
    <div className="page-section auth-section">
      <div className="section-header">
        <div>
          <h1>Creează-ți contul</h1>
          <p className="muted">Alege un rol și începe.</p>
        </div>
        <Link className="button ghost" to="/auth/login">
          Autentificare
        </Link>
      </div>

      <form className="form-card" onSubmit={handleSubmit}>
        <label className="field">
          Nume de utilizator
          <input
            type="text"
            name="username"
            autoComplete="username"
            value={form.username}
            onChange={handleChange}
            required
            minLength={3}
          />
        </label>
        <label className="field">
          Email
          <input
            type="email"
            name="email"
            autoComplete="email"
            value={form.email}
            onChange={handleChange}
            required
          />
          <p className="muted upload-hint">
            Îl folosim ca să îți confirmăm contul și ca să îți poți recupera parola.
          </p>
        </label>
        <label className="field">
          Parolă
          <input
            type="password"
            name="password"
            autoComplete="new-password"
            value={form.password}
            onChange={handleChange}
            required
            minLength={10}
          />
          <p className="muted upload-hint">Minimum 10 caractere.</p>
        </label>
        <label className="field">
          Rol
          <select name="role" value={form.role} onChange={handleChange}>
            <option value="customer">Client</option>
            <option value="vendor">Producător</option>
          </select>
        </label>

        {/* The consent block. The document is readable in place, without
            leaving the form and losing what has been typed. */}
        <div className="legal-consent">
          <label className="legal-consent-check">
            <input
              type="checkbox"
              checked={termsAccepted}
              onChange={(event) => setTermsAccepted(event.target.checked)}
              required
            />
            <span>
              Am citit și accept{' '}
              <Link to={`/legal/${legalDocument.key}`} target="_blank" rel="noopener noreferrer">
                {legalDocument.title.toLowerCase()}
              </Link>{' '}
              (versiunea {legalDocument.version})
              {form.role === 'vendor' && (
                <>
                  {' '}
                  — inclusiv răspunderea integrală pentru siguranța alimentară, documentele și
                  livrarea produselor mele.
                </>
              )}
            </span>
          </label>

          <button
            type="button"
            className="legal-consent-toggle"
            aria-expanded={termsOpen}
            onClick={() => setTermsOpen((open) => !open)}
          >
            {termsOpen ? 'Ascunde textul' : 'Citește aici'}
          </button>

          {termsOpen && (
            <div className="legal-consent-body">
              <Suspense fallback={<p className="muted">Se încarcă textul...</p>}>
                <LegalDocument document={legalDocument} compact />
              </Suspense>
            </div>
          )}

          {versionCheck && !versionCheck.ok && (
            <p className="notice error" role="alert">
              Termenii s-au actualizat între timp
              {versionCheck.serverVersion ? ` (versiunea ${versionCheck.serverVersion})` : ''}.
              Reîncarcă pagina ca să citești versiunea nouă.
            </p>
          )}
        </div>

        <button
          className="button primary"
          type="submit"
          disabled={status.state === 'loading' || !termsAccepted}
        >
          {status.state === 'loading' ? 'Se creează...' : 'Creează cont'}
        </button>
        {status.message && (
          <p
            className={`notice ${status.state === 'error' ? 'error' : 'success'}`}
            role="status"
          >
            {status.message}
          </p>
        )}
        <p className="muted">
          Ai deja cont? <Link to="/auth/login">Autentifică-te</Link>.
        </p>
      </form>
    </div>
  );
}
