// A single Stripe client for the whole process.
//
// Before this module existed, three routes each did
// `require('stripe')(process.env.STRIPE_SECRET_KEY)`. With an unset key that
// silently produced a client that fails on the first call — at payment time,
// in front of a customer. Here the key is checked once, at boot.

const Stripe = require('stripe');

const { STRIPE_SECRET_KEY, STRIPE_CONNECT_ACCOUNT_TYPE } = require('./config');

// Pinning the version means a Stripe API upgrade is a deliberate edit here,
// not something that arrives on its own and changes the shape of a webhook.
const API_VERSION = '2024-06-20';

const stripe = new Stripe(STRIPE_SECRET_KEY, {
  apiVersion: API_VERSION,
  // Two retries on network errors. Every mutating call we make carries an
  // idempotency key, so a retry can never duplicate a charge or a transfer.
  maxNetworkRetries: 2,
  timeout: 20000,
});

/**
 * Stripe errors carry the reason in `code`/`type`, but `err.message` is
 * written for developers. This maps the cases a customer or farmer can
 * actually hit to Romanian text they can act on, and leaves everything else
 * as a generic message plus a request id for the logs.
 */
const describeStripeError = (error) => {
  const type = error?.type || '';
  const code = error?.code || '';

  if (type === 'StripeCardError') {
    return 'Your card was declined. Try another card or contact your bank.';
  }
  if (code === 'account_invalid' || code === 'account_country_invalid_address') {
    return 'The farm\u2019s Stripe account is not fully set up.';
  }
  if (code === 'balance_insufficient') {
    return 'Insufficient funds in the platform account for this operation.';
  }
  if (type === 'StripeConnectionError' || type === 'StripeAPIError') {
    return 'Stripe is not responding right now. Try again in a few minutes.';
  }
  if (type === 'StripeRateLimitError') {
    return 'Too many requests to Stripe. Try again in a few seconds.';
  }
  return 'The payment could not be processed. The team has been notified.';
};

/**
 * The same job for Connect onboarding, which needs entirely different words.
 *
 * `describeStripeError` talks about cards and payments, because that is where
 * it is used. A farmer clicking "Set up payouts" and being told "the payment
 * could not be processed" learns nothing and, worse, thinks something went
 * wrong with a customer's money. These messages name the actual obstacle, and
 * distinguish the two that matter: something the farmer can fix, and
 * something only the platform operator can.
 */
const describeConnectError = (error) => {
  const type = error?.type || '';
  const code = error?.code || '';
  const message = String(error?.message || '');

  // The platform has not finished its own Connect application. Nothing the
  // farmer does will help, and telling them to "try again" wastes their time.
  if (
    code === 'account_invalid' ||
    /connect/i.test(message) &&
      /(not (been )?(enabled|activated)|complete your platform|platform profile)/i.test(message)
  ) {
    return (
      'Payouts are not available yet: the platform\u2019s own Stripe Connect setup is incomplete. ' +
      'This is on our side, not yours — we have been notified.'
    );
  }
  if (code === 'resource_missing') {
    return 'Your payout account could not be found at Stripe. Press the button again to create a new one.';
  }
  if (code === 'account_country_invalid_address') {
    return 'Stripe could not accept the country on your farm profile. Contact us and we will correct it.';
  }
  if (code === 'email_invalid') {
    return 'Stripe rejected the email address on your account. Update it on your profile and try again.';
  }
  if (type === 'StripePermissionError') {
    return 'We do not have permission to manage this Stripe account. Contact us so we can reconnect it.';
  }
  if (type === 'StripeConnectionError' || type === 'StripeAPIError') {
    return 'Stripe is not responding right now. Try again in a few minutes.';
  }
  if (type === 'StripeRateLimitError') {
    return 'Too many requests to Stripe. Try again in a few seconds.';
  }
  if (type === 'StripeInvalidRequestError' && message) {
    // Stripe's own wording for an invalid request is usually specific and
    // actionable ("business_profile[url] is not a valid URL"). Passing it
    // through beats replacing it with a generic sentence.
    return `Stripe rejected the request: ${message}`;
  }
  return 'Stripe could not set up your payout account right now. Try again in a few minutes.';
};

/**
 * Does this error mean the Stripe account we have on file no longer exists?
 *
 * A farmer whose stored account id is dead — deleted at Stripe, or created
 * under a different API key when the platform moved from test to live — is
 * otherwise stuck forever: every click retrieves the same dead id and fails.
 * Recognising it is what lets the onboarding route start over.
 */
const isMissingAccountError = (error) =>
  error?.code === 'resource_missing' ||
  error?.statusCode === 404 ||
  /no such account/i.test(String(error?.message || ''));

/** The `req_...` id Stripe puts on every response — the only useful log key. */
const stripeRequestId = (error) => error?.requestId || error?.raw?.request_id || '';

module.exports = {
  stripe,
  API_VERSION,
  CONNECT_ACCOUNT_TYPE: STRIPE_CONNECT_ACCOUNT_TYPE,
  describeStripeError,
  describeConnectError,
  isMissingAccountError,
  stripeRequestId,
};
