// SEC-04 — Protecție anti-CSRF.
//
// Atacul: cookie-ul de sesiune e SameSite=None (frontend și backend pe domenii
// diferite), iar `multipart/form-data` este un content-type „simplu" în termeni
// CORS. Un formular ascuns de pe orice site poate trimite deci o cerere POST cu
// cookie-ul victimei atașat, fără ca browserul să ceară preflight — exact cazul
// lui POST /api/vendor/profile, unde se schimbă IBAN-ul.
//
// Apărarea are două straturi, ambele fără stare pe server:
//
//   1. Verificarea originii. Orice cerere care schimbă starea trebuie să vină
//      de la o origine din listă. Este bariera reală: browserul atașează Origin
//      la cererile POST și pagina atacatorului nu îl poate falsifica.
//   2. Antet obligatoriu. Un antet propriu forțează browserul să facă preflight,
//      iar preflight-ul e respins de CORS pentru originile străine. Asta scoate
//      formularele HTML simple complet din joc.
//
// Se aplică doar cererilor care poartă un cookie de sesiune: fără autoritate
// ambientală nu există CSRF, iar clienții fără cookie (Stripe, teste, curl)
// rămân tratați de autentificarea normală.

const { ALLOWED_ORIGINS } = require('../lib/config');
const { SESSION_COOKIE_NAME } = require('../lib/auth');
const { ADMIN_COOKIE_NAME } = require('./adminAuth');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const REQUIRED_HEADER = 'x-requested-with';
const REQUIRED_HEADER_VALUE = 'XMLHttpRequest';

/** Rutele apelate de servere, nu de browsere: nu au cum să trimită antetul. */
const EXEMPT_PREFIXES = ['/api/webhook'];

const originOf = (value) => {
  if (typeof value !== 'string' || !value) {
    return '';
  }
  try {
    return new URL(value).origin.replace(/\/$/, '');
  } catch (_error) {
    return '';
  }
};

const hasSessionCookie = (req) =>
  Boolean(req.cookies?.[SESSION_COOKIE_NAME] || req.cookies?.[ADMIN_COOKIE_NAME]);

const isAllowedOrigin = (origin) => Boolean(origin) && ALLOWED_ORIGINS.includes(origin);

const requireSameOrigin = (req, res, next) => {
  if (SAFE_METHODS.has(req.method)) {
    return next();
  }
  if (EXEMPT_PREFIXES.some((prefix) => req.path.startsWith(prefix))) {
    return next();
  }
  // Fără cookie nu există autoritate ambientală de furat.
  if (!hasSessionCookie(req)) {
    return next();
  }

  const origin = originOf(req.get('origin')) || originOf(req.get('referer'));
  if (!isAllowedOrigin(origin)) {
    return res.status(403).json({ error: 'Cross-site request blocked.' });
  }

  if (req.get(REQUIRED_HEADER) !== REQUIRED_HEADER_VALUE) {
    return res.status(403).json({ error: 'Missing X-Requested-With header.' });
  }

  return next();
};

module.exports = {
  requireSameOrigin,
  REQUIRED_HEADER,
  REQUIRED_HEADER_VALUE,
};
