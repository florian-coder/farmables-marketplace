// Loading the legal documents from the versioned Markdown in the repo.
//
// The documents are source files, not database rows, so a change to the terms
// is a commit with a diff and a review — which is the only way a version number
// means anything. `?raw` gives Vite the file as a string at build time.

import termsCustomers from '../content/legal/terms-customers.md?raw';
import termsProducers from '../content/legal/terms-producers.md?raw';
import privacy from '../content/legal/privacy.md?raw';
import returns from '../content/legal/returns.md?raw';
import cookies from '../content/legal/cookies.md?raw';
import contact from '../content/legal/contact.md?raw';
import ranking from '../content/legal/ranking.md?raw';

/**
 * Minimal YAML frontmatter reader.
 *
 * Deliberately not a YAML parser: the frontmatter here is a flat list of
 * `key: value` pairs that we author ourselves, and pulling in a parser to read
 * six strings would be the wrong trade.
 */
const parseFrontmatter = (source) => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  if (!match) {
    return { meta: {}, body: source };
  }

  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator === -1) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    // Strip the quotes we use for values that start with a bracket.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) {
      meta[key] = value;
    }
  }

  return { meta, body: source.slice(match[0].length) };
};

const RAW_DOCUMENTS = {
  'terms-customers': termsCustomers,
  'terms-producers': termsProducers,
  privacy,
  returns,
  cookies,
  contact,
  ranking,
};

/** Every document, keyed by its frontmatter `key`. */
export const LEGAL_DOCUMENTS = Object.fromEntries(
  Object.entries(RAW_DOCUMENTS).map(([key, raw]) => {
    const { meta, body } = parseFrontmatter(raw);
    return [
      key,
      {
        key,
        title: meta.title || key,
        audience: meta.audience || 'all',
        version: meta.version || '0',
        updatedAt: meta.updated_at || '',
        effectiveFrom: meta.effective_from || '',
        // Anything not explicitly marked final renders the draft banner.
        isDraft: meta.status !== 'final',
        body,
      },
    ];
  }),
);

export const getLegalDocument = (key) => LEGAL_DOCUMENTS[key] || null;

/** The document a given role has to accept when creating an account. */
export const signupDocumentFor = (role) =>
  role === 'vendor' ? LEGAL_DOCUMENTS['terms-producers'] : LEGAL_DOCUMENTS['terms-customers'];

/**
 * Cross-check the versions in the Markdown against the ones the API says are
 * in force.
 *
 * The two live in different places by design — the text in this repo, the
 * authority in the backend — so they can drift. When they do, the signup form
 * refuses to submit rather than record consent to a version nobody is showing.
 */
export const reconcileVersions = (document, registry) => {
  const entry = (registry || []).find((item) => item.key === document?.key);
  if (!entry) {
    return { ok: false, reason: 'unknown_document', serverVersion: null };
  }
  if (entry.version !== document.version) {
    return { ok: false, reason: 'version_mismatch', serverVersion: entry.version };
  }
  return { ok: true, serverVersion: entry.version };
};
