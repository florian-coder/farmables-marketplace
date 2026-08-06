// Configurarea sensibilă a aplicației, citită o singură dată, la pornire.
//
// Nicio valoare de aici nu are implicit. Un secret lipsă oprește procesul,
// pentru că alternativa — pornirea cu un secret cunoscut public — înseamnă
// că oricine poate semna singur un cookie de sesiune pentru orice cont.
//
// dotenv se încarcă aici, nu doar în server.js, ca orice punct de intrare
// (server, teste, scripturi) să vadă aceleași variabile. Calea e legată de
// rădăcina pachetului, nu de directorul din care s-a pornit procesul.
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

/** Minimul sub care un secret HMAC nu mai merită numit secret. */
const MIN_SECRET_LENGTH = 32;
const MIN_PASSWORD_LENGTH = 12;

const readRequired = (name, { minLength = 1 } = {}) => {
  const raw = process.env[name];
  if (typeof raw !== 'string' || !raw.trim()) {
    return { name, value: '', problem: 'missing' };
  }
  const value = raw.trim();
  if (value.length < minLength) {
    return {
      name,
      value: '',
      problem: `is ${value.length} characters, the minimum is ${minLength}`,
    };
  }
  return { name, value, problem: null };
};

const entries = [
  readRequired('SESSION_SECRET', { minLength: MIN_SECRET_LENGTH }),
  readRequired('ADMIN_SESSION_SECRET', { minLength: MIN_SECRET_LENGTH }),
  readRequired('ADMIN_USERNAME'),
  readRequired('ADMIN_PASSWORD', { minLength: MIN_PASSWORD_LENGTH }),
  // Stripe: without the secret key nothing can be charged, and without the
  // webhook secret anyone can POST a fake "payment succeeded". Both are
  // required in every environment, exactly like the session secrets — a
  // process that boots without them looks healthy while being unable to take
  // money safely, which is worse than not booting.
  readRequired('STRIPE_SECRET_KEY'),
  readRequired('STRIPE_WEBHOOK_SECRET'),
];

const problems = entries.filter((entry) => entry.problem);

if (problems.length > 0) {
  const lines = problems.map((entry) => `  - ${entry.name}: ${entry.problem}`);
  throw new Error(
    [
      'Incomplete configuration. The process will not start without these environment variables:',
      ...lines,
      '',
      'Generate the secrets with:  openssl rand -base64 48',
      'Put them in your local .env and in the deployed server environment.',
      'There are no defaults: a publicly known secret lets anyone sign a session',
      'cookie for any account.',
    ].join('\n'),
  );
}

const byName = new Map(entries.map((entry) => [entry.name, entry.value]));

/**
 * Originile de la care acceptăm cereri cu cookie. Aceeași listă e folosită și
 * de CORS, și de verificarea anti-CSRF, ca să nu poată devia una de alta.
 */
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || 'http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim().replace(/\/$/, ''))
  .filter(Boolean);

/** Where Stripe sends the farmer back after onboarding, and the customer after paying. */
const FRONTEND_URL = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');

/**
 * Express by default: Stripe runs KYC and collects the IBAN, and the farmer
 * gets a hosted dashboard. Overridable so a future move to Custom accounts is
 * a variable change, not a code change.
 */
const STRIPE_CONNECT_ACCOUNT_TYPE = process.env.STRIPE_CONNECT_ACCOUNT_TYPE || 'express';

module.exports = {
  SESSION_SECRET: byName.get('SESSION_SECRET'),
  ADMIN_SESSION_SECRET: byName.get('ADMIN_SESSION_SECRET'),
  ADMIN_USERNAME: byName.get('ADMIN_USERNAME'),
  ADMIN_PASSWORD: byName.get('ADMIN_PASSWORD'),
  STRIPE_SECRET_KEY: byName.get('STRIPE_SECRET_KEY'),
  STRIPE_WEBHOOK_SECRET: byName.get('STRIPE_WEBHOOK_SECRET'),
  STRIPE_CONNECT_ACCOUNT_TYPE,
  FRONTEND_URL,
  ALLOWED_ORIGINS,
  IS_PRODUCTION: process.env.NODE_ENV === 'production',
};
