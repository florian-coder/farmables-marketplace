// SEC-09b — an address we can actually reach.
//
// Two separate problems, easy to confuse:
//
//   1. **Legacy generated addresses.** Accounts created before email was
//      collected were given `<username>@localfarmers.app`, a domain that does
//      not accept mail. These are not "unverified" — they are *absent*. The
//      person never chose them and will never receive anything sent there.
//
//   2. **Unverified real addresses.** Someone typed an address and has not
//      clicked the link yet. It might be a typo, it might just be Tuesday.
//
// The distinction matters because the remedy differs: (1) needs a new address
// before anything can be sent, (2) needs a reminder.
//
// **What we gate, and what we do not.** Verification is *not* required to sign
// in, browse, or chat — locking people out of an account they can prove they
// own by having the password is punishment, not security. It IS required to
// pay, because a checkout produces an order confirmation that the law says
// must reach a durable medium (GEO 34/2014 art. 8). An order we cannot confirm
// is an order we should not take.

/** The domain the old signup flow invented addresses on. */
const GENERATED_EMAIL_DOMAIN = '@localfarmers.app';

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const EMAIL_STATES = Object.freeze({
  /** A real address, confirmed by clicking the link. */
  VERIFIED: 'verified',
  /** A real address the owner typed, not confirmed yet. */
  UNVERIFIED: 'unverified',
  /** `user@localfarmers.app` — nobody reads this. Needs replacing. */
  MISSING: 'missing',
});

/**
 * True for the addresses the old flow invented.
 *
 * Matched on the domain rather than a per-user record because that is the only
 * evidence we have: the accounts were created before any column recorded how
 * the address came to exist.
 */
const isGeneratedEmail = (email) =>
  String(email || '')
    .trim()
    .toLowerCase()
    .endsWith(GENERATED_EMAIL_DOMAIN);

const looksLikeEmail = (email) => EMAIL_SHAPE.test(String(email || '').trim());

/** Where an account stands. Takes a `users` row. */
const emailStatus = (user) => {
  const email = String(user?.email || '').trim();

  if (!email || !looksLikeEmail(email) || isGeneratedEmail(email)) {
    return EMAIL_STATES.MISSING;
  }
  return user?.email_verified === true || user?.email_verified === 1
    ? EMAIL_STATES.VERIFIED
    : EMAIL_STATES.UNVERIFIED;
};

/**
 * May this account pay for something?
 *
 * Returns `null` when it may, or `{ code, error }` when it may not. A missing
 * address is a hard stop; an unverified one is not — we have somewhere to send
 * the confirmation, and blocking a first purchase on an unclicked link loses
 * far more than it protects.
 */
const checkoutBlockerFor = (user) => {
  const status = emailStatus(user);

  if (status === EMAIL_STATES.MISSING) {
    return {
      code: 'email_missing',
      error:
        'We need a real email address before you can order — we have to send you the order ' +
        'confirmation. Add one in your profile.',
    };
  }
  return null;
};

module.exports = {
  GENERATED_EMAIL_DOMAIN,
  EMAIL_STATES,
  isGeneratedEmail,
  looksLikeEmail,
  emailStatus,
  checkoutBlockerFor,
};
