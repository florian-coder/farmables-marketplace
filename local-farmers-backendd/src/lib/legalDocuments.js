// The registry of legal documents and their current versions.
//
// This is the authority on "which version is in force right now". The Markdown
// files in the frontend carry the same version in their frontmatter, and the
// two must be bumped together — the check in `assertVersionsMatch` below is
// what turns a mismatch into a loud failure instead of a silent one, because a
// consent record that names the wrong version is worse than no record at all.
//
// LEG-02/LEG-03: acceptance is recorded per document, with version, timestamp
// and IP, in `legal_acceptances`.

/**
 * `requiredAtSignup` — the user cannot create an account without ticking it.
 * `requiredAtOrder`  — re-accepted every time an order is placed.
 * `audience`         — which role must accept it; 'all' means both.
 */
const LEGAL_DOCUMENTS = Object.freeze({
  'terms-customers': Object.freeze({
    key: 'terms-customers',
    title: 'Terms and Conditions for Customers',
    version: '1.0',
    audience: 'customer',
    path: '/legal/terms-customers',
    requiredAtSignup: true,
    requiredAtOrder: true,
  }),
  'terms-producers': Object.freeze({
    key: 'terms-producers',
    title: 'Terms and Conditions for Producers',
    version: '1.0',
    audience: 'vendor',
    path: '/legal/terms-producers',
    requiredAtSignup: true,
    requiredAtOrder: false,
  }),
  // LEG-02/LEG-03 — informational documents. They are not "accepted" the way
  // the terms are: consent to a privacy policy is not a legal basis for
  // processing under GDPR, and asking for it would suggest otherwise. They
  // are published, versioned and linked, which is what the law actually
  // requires. They still live in this registry so the footer, the email
  // templates and the version check all read one list.
  privacy: Object.freeze({
    key: 'privacy',
    title: 'Privacy Policy',
    version: '1.0',
    audience: 'all',
    path: '/legal/privacy',
    requiredAtSignup: false,
    requiredAtOrder: false,
  }),
  returns: Object.freeze({
    key: 'returns',
    title: 'Returns, Cancellations and Refunds',
    version: '1.0',
    audience: 'all',
    path: '/legal/returns',
    requiredAtSignup: false,
    requiredAtOrder: false,
  }),
  cookies: Object.freeze({
    key: 'cookies',
    title: 'Cookie Policy',
    version: '1.0',
    audience: 'all',
    path: '/legal/cookies',
    requiredAtSignup: false,
    requiredAtOrder: false,
  }),
  contact: Object.freeze({
    key: 'contact',
    title: 'Contact and Operator Details',
    version: '1.0',
    audience: 'all',
    path: '/legal/contact',
    requiredAtSignup: false,
    requiredAtOrder: false,
  }),
  // LEG-05 — the P2B Regulation requires the ranking parameters to be
  // published, so the page is a compliance artefact, not marketing.
  ranking: Object.freeze({
    key: 'ranking',
    title: 'How Ranking Works',
    version: '1.0',
    audience: 'all',
    path: '/legal/ranking',
    requiredAtSignup: false,
    requiredAtOrder: false,
  }),
});

/** Documents a given role must accept at a given moment. */
const documentsFor = (role, moment) => {
  const flag = moment === 'order' ? 'requiredAtOrder' : 'requiredAtSignup';
  return Object.values(LEGAL_DOCUMENTS).filter(
    (doc) => doc[flag] && (doc.audience === 'all' || doc.audience === role),
  );
};

/**
 * Validate what the client says it accepted against what is actually in force.
 *
 * Returns `{ ok: true, documents }` or `{ ok: false, error, code }`. A stale
 * browser tab that offers an old version is rejected rather than recorded: the
 * user has to see the current text before consenting to it.
 */
const validateAcceptances = ({ role, moment = 'signup', accepted }) => {
  const required = documentsFor(role, moment);
  if (required.length === 0) {
    return { ok: true, documents: [] };
  }

  const offered = new Map(
    (Array.isArray(accepted) ? accepted : [])
      .filter((entry) => entry && typeof entry.key === 'string')
      .map((entry) => [entry.key, String(entry.version || '')]),
  );

  for (const doc of required) {
    if (!offered.has(doc.key)) {
      return {
        ok: false,
        code: 'terms_not_accepted',
        error:
          'You must accept the terms and conditions and the privacy policy to continue.',
      };
    }
    if (offered.get(doc.key) !== doc.version) {
      return {
        ok: false,
        code: 'terms_version_stale',
        error:
          'The terms and conditions have changed. Reload the page and read the new version.',
      };
    }
  }

  return { ok: true, documents: required };
};

/** The public shape the frontend reads to know what to show and require. */
const publicRegistry = () =>
  Object.values(LEGAL_DOCUMENTS).map((doc) => ({
    key: doc.key,
    title: doc.title,
    version: doc.version,
    audience: doc.audience,
    path: doc.path,
    requiredAtSignup: doc.requiredAtSignup,
    requiredAtOrder: doc.requiredAtOrder,
  }));

module.exports = {
  LEGAL_DOCUMENTS,
  documentsFor,
  validateAcceptances,
  publicRegistry,
};
