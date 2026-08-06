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
    return 'Cardul a fost refuzat. Încearcă alt card sau contactează banca.';
  }
  if (code === 'account_invalid' || code === 'account_country_invalid_address') {
    return 'Contul Stripe al fermierului nu este complet configurat.';
  }
  if (code === 'balance_insufficient') {
    return 'Fonduri insuficiente în contul platformei pentru această operațiune.';
  }
  if (type === 'StripeConnectionError' || type === 'StripeAPIError') {
    return 'Stripe nu răspunde momentan. Reîncearcă în câteva minute.';
  }
  if (type === 'StripeRateLimitError') {
    return 'Prea multe cereri către Stripe. Reîncearcă în câteva secunde.';
  }
  return 'Plata nu a putut fi procesată. Am notificat echipa.';
};

/** The `req_...` id Stripe puts on every response — the only useful log key. */
const stripeRequestId = (error) => error?.requestId || error?.raw?.request_id || '';

module.exports = {
  stripe,
  API_VERSION,
  CONNECT_ACCOUNT_TYPE: STRIPE_CONNECT_ACCOUNT_TYPE,
  describeStripeError,
  stripeRequestId,
};
