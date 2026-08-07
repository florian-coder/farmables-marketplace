// LEG-07 (DSA Art. 30) and OPS-05 — who the seller is, and how to reach them.
//
// Two findings that pull in opposite directions, which is why they belong in
// one file:
//
//   **LEG-07** — the Digital Services Act art. 30 requires a marketplace to
//   publish enough about each trader that a consumer knows who they are
//   contracting with: name, registered address, registration number, contact
//   details. Customer terms §7.2 already promises this. Not showing it is both
//   a breach and a broken promise.
//
//   **OPS-05** — the farm's phone number and email currently render as `tel:`
//   and `mailto:` links to anyone at all, before any order. That is a scraped
//   contact list waiting to happen, and it is how a marketplace gets
//   disintermediated: the customer calls, pays cash, and loses every
//   protection they were about to have.
//
// The resolution is that these are different pieces of information:
//
//   * **Identification** (legal name, registration number, registered office)
//     is public, always. It is what DSA Art. 30 asks for, it is a matter of
//     public record anyway, and it is not a channel anyone can spam.
//   * **Direct contact** (phone, personal email) is revealed once there is a
//     paid order between the two of you. Before that, the chat is the channel
//     — which is also the channel we can moderate and keep a record of.
//
// A registered office is not a private address in the sense a mobile number
// is: a company's seat is published in the trade register. Where a producer is
// an individual trading from home, that is a genuine tension, and §7.2 of the
// terms says so.

const { supabase, TABLES } = require('./supabase');

/**
 * Has this customer ever paid this farm?
 *
 * "Ever", not "currently": once you have bought from someone, having their
 * number is reasonable forever. Re-hiding it after the order completes would
 * be pointless — they already wrote it down.
 */
const hasPaidOrderBetween = async ({ customerId, farmerId }) => {
  if (!customerId || !farmerId) {
    return false;
  }

  const { data, error } = await supabase
    .from(TABLES.orders)
    .select('id')
    .eq('client_id', String(customerId))
    .eq('farmer_id', String(farmerId))
    .not('paid_at', 'is', null)
    .limit(1);

  if (error) {
    // Failing closed: a lookup error hides the contact details rather than
    // revealing them. The chat still works.
    return false;
  }
  return Array.isArray(data) && data.length > 0;
};

/**
 * The block DSA Art. 30 requires, always public.
 *
 * Missing values render as an explicit gap rather than being omitted: a farm
 * that has not supplied its registration number should look incomplete, not
 * look like it has nothing to declare.
 */
const publicTraderDetails = (farmer) => ({
  legalName: farmer?.legal_name || farmer?.['farm name'] || '',
  // CUI / trade register, collected at approval from the uploaded documents.
  registrationNumber: farmer?.trade_register_number || '',
  vatNumber: farmer?.cui || '',
  registeredOffice: [
    farmer?.['street address'],
    farmer?.['street number'],
    farmer?.city,
    farmer?.county,
  ]
    .filter(Boolean)
    .join(', '),
  // Whether this producer trades as a business or as a private individual —
  // DSA Art. 30(1)(e), and it changes which consumer rights apply.
  traderType: farmer?.trader_type || 'unknown',
  isComplete: Boolean(
    (farmer?.legal_name || farmer?.['farm name']) &&
      (farmer?.trade_register_number || farmer?.cui) &&
      farmer?.city,
  ),
});

/**
 * Merge the trader block and the contact rules into the vendor shape.
 *
 * `revealContact` is decided by the caller, which is the only place that knows
 * who is asking.
 */
const applyContactVisibility = (vendor, { revealContact }) => {
  if (revealContact) {
    return { ...vendor, contactVisible: true };
  }

  return {
    ...vendor,
    // Emptied, not omitted, so the frontend renders "message the farm" rather
    // than a blank where a phone number used to be.
    phoneNumber: '',
    email: '',
    contactVisible: false,
    contactHiddenReason:
      'Phone and email are shown once you have an order with this farm. Until then, message them here — that way there is a record if anything goes wrong.',
  };
};

module.exports = { hasPaidOrderBetween, publicTraderDetails, applyContactVisibility };
