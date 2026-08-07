// Who is actually behind this site.
//
// LEG-02 — OUG 34/2014 art. 6 and Law 365/2002 art. 5 both require the trader
// to be identifiable *before* the customer commits: legal name, registration
// number, registered office, and a way to reach a human. The same block has to
// appear in the site footer and at the bottom of every transactional email,
// which is why it is one module rather than two copies that drift apart.
//
// These are environment variables, not constants, because they are the kind of
// detail that changes on a Tuesday — a new office, a new phone number — and
// nobody should need a code review and a deploy to fix a phone number.
//
// The defaults are deliberately visible placeholders. A missing CUI rendering
// as "[CUI NOT CONFIGURED]" on the live footer is embarrassing enough to get
// fixed; a blank line is not.

const readOperator = (name, fallback) => {
  const raw = process.env[name];
  return typeof raw === 'string' && raw.trim() ? raw.trim() : fallback;
};

const OPERATOR = Object.freeze({
  /** Trading name, the one customers recognise. */
  brand: readOperator('OPERATOR_BRAND', 'Farmables'),
  /** Registered legal name, which is often not the brand. */
  legalName: readOperator('OPERATOR_LEGAL_NAME', '[LEGAL NAME NOT CONFIGURED]'),
  /** CUI / VAT registration number. */
  cui: readOperator('OPERATOR_CUI', '[CUI NOT CONFIGURED]'),
  /** Trade register number (J.../.../...). */
  tradeRegister: readOperator('OPERATOR_TRADE_REGISTER', '[TRADE REGISTER NOT CONFIGURED]'),
  /** Registered office, one line. */
  address: readOperator('OPERATOR_ADDRESS', '[REGISTERED OFFICE NOT CONFIGURED]'),
  email: readOperator('OPERATOR_EMAIL', 'hello@farmables.ro'),
  phone: readOperator('OPERATOR_PHONE', '[PHONE NOT CONFIGURED]'),
  /**
   * ANPC — the consumer protection authority. Romanian law requires the link
   * to the online dispute platforms to be reachable from every page.
   */
  anpcUrl: readOperator('OPERATOR_ANPC_URL', 'https://anpc.ro/'),
  /** SAL — alternative dispute resolution. */
  anpcSalUrl: readOperator('OPERATOR_ANPC_SAL_URL', 'https://anpc.ro/ce-este-sal/'),
  /** SOL — the EU online dispute resolution platform. */
  anpcSolUrl: readOperator(
    'OPERATOR_ANPC_SOL_URL',
    'https://ec.europa.eu/consumers/odr',
  ),
});

/** One-line identification, for email footers. */
const operatorLine = () =>
  `${OPERATOR.legalName} · CUI ${OPERATOR.cui} · ${OPERATOR.address} · ${OPERATOR.email}`;

/** Anything still on a placeholder — surfaced by the health endpoint. */
const missingOperatorFields = () =>
  Object.entries(OPERATOR)
    .filter(([, value]) => typeof value === 'string' && value.startsWith('['))
    .map(([key]) => key);

module.exports = { OPERATOR, operatorLine, missingOperatorFields };
