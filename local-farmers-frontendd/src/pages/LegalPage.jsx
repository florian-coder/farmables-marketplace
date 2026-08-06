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
        <h1>Document unavailable</h1>
        <p className="muted">The requested document does not exist.</p>
        <Link className="button primary" to="/">
          Back to home
        </Link>
      </div>
    );
  }

  return (
    <div className="page-section legal-page">
      <LegalDocument document={document} />

      <nav className="legal-page-nav" aria-label="Other documents">
        <Link to="/legal/terms-customers">Customer terms</Link>
        <Link to="/legal/terms-producers">Producer terms</Link>
      </nav>
    </div>
  );
}
