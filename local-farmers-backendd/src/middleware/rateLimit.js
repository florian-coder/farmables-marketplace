// SEC-07 — Limitare de rată.
//
// Trei niveluri, după cât de scump e abuzul:
//   authLimiter    — autentificare și resetare de parolă, pe IP
//   usernameLimiter— aceleași rute, dar pe numele contului țintit, ca un atac
//                    distribuit pe mai multe IP-uri să nu ocolească prima limită
//   writeLimiter   — restul cererilor care schimbă starea
//
// Magazia e în memorie: corectă pentru o singură instanță. Dacă backendul
// ajunge să ruleze pe mai multe procese, trebuie mutată pe Redis, altfel
// fiecare instanță numără separat.

const rateLimit = require('express-rate-limit');

const jsonMessage = (message) => ({ error: message });

const baseOptions = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // Testele pornesc de pe aceeași adresă și ar declanșa limita instantaneu.
  // Steagul e explicit, ca suita dedicată limitării să îl poată lăsa activ.
  skip: () => process.env.DISABLE_RATE_LIMIT === '1',
};

const authLimiter = rateLimit({
  ...baseOptions,
  windowMs: 15 * 60 * 1000,
  limit: 10,
  message: jsonMessage('Too many attempts. Try again in 15 minutes.'),
});

const usernameLimiter = rateLimit({
  ...baseOptions,
  windowMs: 15 * 60 * 1000,
  limit: 8,
  keyGenerator: (req) => {
    const raw = req.body?.username ?? req.body?.email ?? '';
    return `account:${String(raw).trim().toLowerCase().slice(0, 64)}`;
  },
  message: jsonMessage('Too many attempts for this account. Try again in 15 minutes.'),
});

const writeLimiter = rateLimit({
  ...baseOptions,
  windowMs: 60 * 1000,
  limit: 60,
  message: jsonMessage('Too many requests. Slow down.'),
});

/**
 * SEC-12 — the admin panel gets its own, much tighter limit.
 *
 * Separate from `authLimiter` on purpose. There is a handful of admins and
 * they sign in a few times a day; a customer-facing allowance of ten attempts
 * per quarter hour is far more room than that needs, and this endpoint is the
 * one where a successful guess can refund money and suspend farms.
 *
 * Five per hour, per IP. `admin_users.failed_attempts` locks the account after
 * five failures independently — this stops the attempt reaching the account at
 * all, so a distributed attack cannot lock out every admin as a denial of
 * service.
 */
const adminAuthLimiter = rateLimit({
  ...baseOptions,
  windowMs: 60 * 60 * 1000,
  limit: 5,
  message: jsonMessage('Too many sign-in attempts. Try again in an hour.'),
});

module.exports = { authLimiter, usernameLimiter, writeLimiter, adminAuthLimiter };
