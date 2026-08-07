// OPS-07 — chat moderation.
//
// The design decision worth defending: **the filter flags, it does not
// block.**
//
// A farmer and a customer arranging a delivery legitimately exchange phone
// numbers, addresses and times. A filter that refused those messages would
// break the single most common conversation on the platform in order to catch
// a rare one. So a flagged message is delivered, the sender is shown a warning
// about what they are giving up, and a report lands for review.
//
// The one thing worth flagging hardest is not profanity — it is steering the
// deal off-platform. Not because of our commission, but because a customer who
// pays cash at the gate has no refund, no dispute process and no traceability
// record, and does not find that out until something goes wrong.
//
// The patterns are deliberately shallow. A determined person routes around any
// list, and a deep one produces false positives that train people to ignore
// the warning. This catches the careless case, which is most of them.

/** What a flag means, and how loudly to say it. */
const FLAG_KINDS = Object.freeze({
  OFF_PLATFORM_PAYMENT: 'off_platform_payment',
  CONTACT_DETAILS: 'contact_details',
  ABUSE: 'abuse',
});

const PATTERNS = [
  {
    kind: FLAG_KINDS.OFF_PLATFORM_PAYMENT,
    // Romanian and English, because the site runs in English but the
    // conversations do not.
    tests: [
      /\b(cash|numerar|bani\s+jos|la\s+mân[ăa]|plata\s+direct)\b/i,
      /\b(revolut|paypal|transfer\s+bancar|iban|western\s+union)\b/i,
      /\bf[ăa]r[ăa]\s+(comision|platform[ăa]|site)\b/i,
      /\b(outside|off)\s+the\s+(platform|site|app)\b/i,
      /\bpay\s+me\s+(direct|directly|in\s+cash)\b/i,
    ],
    severity: 'high',
    warning:
      'Paying outside the platform means no refund protection, no dispute process and no record ' +
      'of the sale. We have flagged this message for review.',
  },
  {
    kind: FLAG_KINDS.CONTACT_DETAILS,
    tests: [
      // Romanian mobile numbers, with or without spacing.
      /\b(?:\+?4?0)\s?7\d{2}[\s.-]?\d{3}[\s.-]?\d{3}\b/,
      /\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/i,
      /\b(whatsapp|telegram|viber|signal)\b/i,
    ],
    severity: 'low',
    warning:
      'Sharing contact details is fine for arranging a delivery, but keep the order and the ' +
      'payment here — that is what gives you a refund if something goes wrong.',
  },
  {
    kind: FLAG_KINDS.ABUSE,
    tests: [
      /\b(idiot|prost|imbecil|cretin|jeg|nesim[țt]it)\b/i,
      /\b(hoț|escroc|scammer|thief|fraud)\b/i,
    ],
    severity: 'medium',
    warning: 'This message has been flagged for review.',
  },
];

/**
 * Inspect one message.
 *
 * Returns `{ flagged, kinds, severity, warning }`. Never rejects — the caller
 * sends the message either way.
 */
const inspectMessage = (text) => {
  const value = String(text || '');
  const kinds = [];
  let severity = 'none';
  let warning = '';

  const rank = { none: 0, low: 1, medium: 2, high: 3 };

  for (const pattern of PATTERNS) {
    if (pattern.tests.some((test) => test.test(value))) {
      kinds.push(pattern.kind);
      if (rank[pattern.severity] > rank[severity]) {
        severity = pattern.severity;
        warning = pattern.warning;
      }
    }
  }

  return { flagged: kinds.length > 0, kinds, severity, warning };
};

/**
 * Whether a message may be delivered at all.
 *
 * The only hard stop is a block, and it is one-directional: blocking stops
 * *them* reaching *you*. The blocked person is told the message could not be
 * delivered but never that they were blocked — a block that announces itself
 * invites retaliation through some other channel.
 */
const blockedBetween = async ({ supabase, tables, senderId, recipientId }) => {
  if (!senderId || !recipientId) {
    return false;
  }

  const { data, error } = await supabase
    .from(tables.userBlocks)
    .select('id, blocker_user_id, blocked_user_id')
    .or(
      `blocker_user_id.eq.${recipientId},blocker_user_id.eq.${senderId}`,
    );

  if (error) {
    // A moderation lookup that fails must not silently open the channel, but
    // it must not close a legitimate conversation either. Delivering is the
    // less harmful default: the report path still exists.
    console.error('[moderation] Block lookup failed:', error.message);
    return false;
  }

  return (Array.isArray(data) ? data : []).some(
    (row) =>
      (String(row.blocker_user_id) === String(recipientId) &&
        String(row.blocked_user_id) === String(senderId)) ||
      (String(row.blocker_user_id) === String(senderId) &&
        String(row.blocked_user_id) === String(recipientId)),
  );
};

module.exports = { FLAG_KINDS, PATTERNS, inspectMessage, blockedBetween };
