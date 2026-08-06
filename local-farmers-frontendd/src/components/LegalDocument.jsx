// One renderer for every legal document.
//
// The documents are Markdown so that a change to the terms is a reviewable
// diff. This component turns one into a page: title, version, effective date,
// the draft banner, and the body.

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const formatDate = (value) => {
  if (!value) {
    return '';
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    // Placeholders like "[EFFECTIVE DATE]" pass through unchanged.
    return value;
  }
  return parsed.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
};

/**
 * `compact` renders the body only, without the page header — used inside the
 * signup dialog, where the surrounding chrome already says what the document is.
 */
export default function LegalDocument({ document, compact = false }) {
  if (!document) {
    return (
      <p className="notice error" role="alert">
        This document was not found.
      </p>
    );
  }

  return (
    <article className={`legal-document ${compact ? 'is-compact' : ''}`}>
      {!compact && (
        <header className="legal-document-head">
          <h1>{document.title}</h1>
          <p className="legal-document-meta">
            Version {document.version}
            {document.updatedAt ? ` · updated ${formatDate(document.updatedAt)}` : ''}
            {document.effectiveFrom ? ` · effective from ${formatDate(document.effectiveFrom)}` : ''}
          </p>
        </header>
      )}

      {/* Honest rather than decorative: the text has not been through a lawyer
          yet, and saying so is both fairer to the reader and safer for us than
          presenting a draft as settled terms. */}
      {document.isDraft && (
        <p className="legal-draft-banner" role="status">
          <strong>Working draft.</strong> This text is a draft under legal review. It is not the
          final version and may change before it takes effect.
        </p>
      )}

      <div className="legal-document-body">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            // Tables in these documents are wide; let them scroll inside their
            // own box instead of pushing the page sideways.
            table: ({ node: _node, ...props }) => (
              <div className="legal-table-wrap">
                <table {...props} />
              </div>
            ),
            a: ({ node: _node, href, ...props }) => (
              <a
                href={href}
                {...props}
                {...(href?.startsWith('http')
                  ? { target: '_blank', rel: 'noopener noreferrer' }
                  : {})}
              />
            ),
          }}
        >
          {document.body}
        </ReactMarkdown>
      </div>
    </article>
  );
}
