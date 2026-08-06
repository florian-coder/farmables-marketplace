// The public page for a legal document.
//
// One route serves every document; which one is decided by the `documentKey`
// prop the route passes in. Adding a document is a Markdown file plus a route,
// never a new page component.

import { Link } from 'react-router-dom';

import LegalDocument from '../components/LegalDocument.jsx';
import { getLegalDocument } from '../lib/legal.js';

export default function LegalPage({ documentKey }) {
  const document = getLegalDocument(documentKey);

  if (!document) {
    return (
      <div className="page-section">
        <h1>Document indisponibil</h1>
        <p className="muted">Documentul cerut nu există.</p>
        <Link className="button primary" to="/">
          Înapoi la pagina principală
        </Link>
      </div>
    );
  }

  return (
    <div className="page-section legal-page">
      <LegalDocument document={document} />

      <nav className="legal-page-nav" aria-label="Alte documente">
        <Link to="/legal/terms-customers">Termeni pentru clienți</Link>
        <Link to="/legal/terms-producers">Termeni pentru producători</Link>
      </nav>
    </div>
  );
}
