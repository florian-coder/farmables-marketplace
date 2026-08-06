// Pornește aplicația reală, cu Supabase înlocuit de cel fals. Rutele,
// middleware-ul de autentificare, CSRF-ul și limitatoarele sunt cele din
// producție — doar baza de date e în memorie.

const path = require('path');

const { createFakeSupabase } = require('./fakeSupabase');

const BACKEND_ROOT = path.join(__dirname, '..', '..');
const ORIGIN = 'http://localhost:5173';

/**
 * Construiește o aplicație izolată. Fiecare apel primește module proaspete,
 * ca starea limitatoarelor de rată să nu se scurgă între teste.
 */
const buildApp = (seed = {}) => {
  // Registru curat la fiecare apel: altfel starea limitatoarelor de rată și
  // clientul Supabase deja capturat de rute s-ar scurge între teste.
  jest.resetModules();
  const fake = createFakeSupabase(seed);

  jest.doMock('../../src/lib/supabase.js', () => {
    const actual = jest.requireActual('../../src/lib/supabase.js');
    return { ...actual, supabase: fake };
  });

  // eslint-disable-next-line global-require
  const app = require(path.join(BACKEND_ROOT, 'src/app.js'));
  return { app, fake };
};

/** Antetele pe care le trimite frontendul real la o cerere care schimbă starea. */
const browserHeaders = { Origin: ORIGIN, 'X-Requested-With': 'XMLHttpRequest' };

/** Cookie de sesiune valid, emis cu codul real. */
const sessionCookieFor = async (user) => {
  const { createSession, SESSION_COOKIE_NAME } = require(
    path.join(BACKEND_ROOT, 'src/lib/auth.js'),
  );
  const session = await createSession({
    id: user.id,
    role: user.role,
    tokenVersion: user.tokenVersion ?? 0,
  });
  return `${SESSION_COOKIE_NAME}=${session.token}`;
};

const adminCookie = () => {
  const { createAdminSessionToken, ADMIN_COOKIE_NAME } = require(
    path.join(BACKEND_ROOT, 'src/middleware/adminAuth.js'),
  );
  return `${ADMIN_COOKIE_NAME}=${createAdminSessionToken()}`;
};

module.exports = { buildApp, browserHeaders, sessionCookieFor, adminCookie, ORIGIN };
