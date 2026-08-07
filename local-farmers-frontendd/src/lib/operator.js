// Who operates this site — the version that renders in the footer.
//
// LEG-02 — OUG 34/2014 art. 6 and Law 365/2002 art. 5 require the trader to be
// identifiable from every page, before the customer commits to anything.
//
// This is build-time configuration rather than something fetched from the API,
// deliberately: the identification block is a legal requirement that must
// render even when the backend is down, and a footer that flashes in after a
// round trip is a footer people scroll past. It is public information — the
// same data that is on the company's registration — so there is nothing here
// worth protecting.
//
// The backend has a mirror of this in `src/lib/operator.js` for email
// footers. The two read the same variable names (`VITE_OPERATOR_*` here,
// `OPERATOR_*` there) and must be set together. The backend warns at boot when
// any of its values are still placeholders.

const read = (value, fallback) =>
  typeof value === 'string' && value.trim() ? value.trim() : fallback;

export const OPERATOR = Object.freeze({
  brand: read(import.meta.env.VITE_OPERATOR_BRAND, 'Farmables'),
  legalName: read(import.meta.env.VITE_OPERATOR_LEGAL_NAME, '[LEGAL NAME NOT CONFIGURED]'),
  cui: read(import.meta.env.VITE_OPERATOR_CUI, '[CUI NOT CONFIGURED]'),
  tradeRegister: read(
    import.meta.env.VITE_OPERATOR_TRADE_REGISTER,
    '[TRADE REGISTER NOT CONFIGURED]',
  ),
  address: read(import.meta.env.VITE_OPERATOR_ADDRESS, '[REGISTERED OFFICE NOT CONFIGURED]'),
  email: read(import.meta.env.VITE_OPERATOR_EMAIL, 'hello@farmables.ro'),
  phone: read(import.meta.env.VITE_OPERATOR_PHONE, '[PHONE NOT CONFIGURED]'),
  anpcUrl: read(import.meta.env.VITE_OPERATOR_ANPC_URL, 'https://anpc.ro/'),
  anpcSalUrl: read(import.meta.env.VITE_OPERATOR_ANPC_SAL_URL, 'https://anpc.ro/ce-este-sal/'),
  anpcSolUrl: read(
    import.meta.env.VITE_OPERATOR_ANPC_SOL_URL,
    'https://ec.europa.eu/consumers/odr',
  ),
});

/** True while a value is still a placeholder, so the UI can flag it in dev. */
export const isPlaceholder = (value) => typeof value === 'string' && value.startsWith('[');
