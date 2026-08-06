const express = require('express');
const crypto = require('crypto');

const {
  hashPassword,
  verifyPassword,
  createSession,
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  revokeUserSessions,
} = require('../lib/auth');
const { getUserFromRequest, requireAuth } = require('../middleware/auth');
const { authLimiter, usernameLimiter } = require('../middleware/rateLimit');
const { supabase, TABLES } = require('../lib/supabase');
const { mapDbUserToApi, normalizeText, toDbUserType } = require('../lib/domain');
const { sendMail } = require('../lib/mailer');
const { ACTIONS, recordAudit } = require('../lib/audit');
const { IS_PRODUCTION } = require('../lib/config');
const { validateAcceptances } = require('../lib/legalDocuments');
const { recordAcceptances } = require('../lib/legalAcceptance');

const router = express.Router();

/** SEC-07 — politica de parole. Se aplică la înregistrare, schimbare, resetare. */
const MIN_PASSWORD_LENGTH = 10;

/**
 * Parolele care apar de departe cel mai des în listele scurse. Nu e o listă
 * completă — e filtrul ieftin care oprește alegerile catastrofale.
 */
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', '123456', '1234567', '12345678',
  '123456789', '1234567890', 'qwerty', 'qwerty123', 'qwertyuiop', 'iloveyou',
  'admin123', 'welcome1', 'welcome123', 'letmein', 'letmein123', 'abc123456',
  'parola123', 'parolamea', 'administrator', 'football', 'monkey123',
  'dragon123', 'sunshine', 'princess', 'baseball', 'trustno1',
]);

const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;

const normalizeUsername = (username) => normalizeText(username, 32).toLowerCase();
const normalizeEmail = (email) =>
  typeof email === 'string' ? email.trim().toLowerCase().slice(0, 180) : '';

const isValidRole = (role) => role === 'customer' || role === 'vendor';

/** Returnează un mesaj de eroare, sau null dacă parola e acceptabilă. */
const validatePassword = (password, { username = '' } = {}) => {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > 200) {
    return 'Password must be at most 200 characters.';
  }

  const lowered = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lowered)) {
    return 'That password appears in known breach lists. Pick another one.';
  }
  if (username && lowered.includes(String(username).toLowerCase())) {
    return 'Password must not contain your username.';
  }
  return null;
};

const sessionCookieOptions = () => ({
  httpOnly: true,
  sameSite: IS_PRODUCTION ? 'none' : 'lax',
  secure: IS_PRODUCTION,
  maxAge: SESSION_TTL_MS,
  path: '/',
});

const createRoleProfile = async ({ userId, role }) => {
  if (role === 'vendor') {
    return null;
  }

  const { error } = await supabase.from(TABLES.customers).insert({
    id: userId,
    name: '',
    surname: '',
    'address street': '',
    'address number': '',
    'phone number': '',
    city: '',
    county: '',
    country: '',
  });
  return error;
};

/** Tokenurile se păstrează doar ca hash: o scurgere a tabelului nu le expune. */
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

const issueAuthToken = async ({ userId, purpose, ttlMs }) => {
  const token = crypto.randomBytes(32).toString('base64url');
  const { error } = await supabase.from(TABLES.authTokens).insert({
    user_id: String(userId),
    purpose,
    token_hash: hashToken(token),
    expires_at: new Date(Date.now() + ttlMs).toISOString(),
  });
  if (error) {
    throw new Error(error.message || 'Unable to issue token.');
  }
  return token;
};

const consumeAuthToken = async (token, purpose) => {
  if (typeof token !== 'string' || !token) {
    return null;
  }

  const { data: row, error } = await supabase
    .from(TABLES.authTokens)
    .select('id, user_id, purpose, expires_at, used_at')
    .eq('token_hash', hashToken(token))
    .eq('purpose', purpose)
    .maybeSingle();

  if (error || !row || row.used_at) {
    return null;
  }
  if (Date.parse(row.expires_at) <= Date.now()) {
    return null;
  }

  // Marcăm ca folosit înainte de a acționa: un token e de unică folosință.
  const { error: useError } = await supabase
    .from(TABLES.authTokens)
    .update({ used_at: new Date().toISOString() })
    .eq('id', row.id)
    .is('used_at', null);
  if (useError) {
    return null;
  }

  return { userId: String(row.user_id) };
};

router.post('/signup', authLimiter, async (req, res, next) => {
  try {
    const { username, password, role, email } = req.body || {};
    if (!username || typeof username !== 'string') {
      return res.status(400).json({ error: 'Username is required.' });
    }

    const normalized = normalizeUsername(username);
    if (normalized.length < 3 || normalized.length > 32) {
      return res.status(400).json({ error: 'Username must be 3-32 characters.' });
    }

    const passwordProblem = validatePassword(password, { username: normalized });
    if (passwordProblem) {
      return res.status(400).json({ error: passwordProblem });
    }
    if (!isValidRole(role)) {
      return res.status(400).json({ error: 'Role must be customer or vendor.' });
    }

    // SEC-09: emailul e obligatoriu, ca recuperarea contului să fie posibilă.
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normalizedEmail)) {
      return res.status(400).json({ error: 'A valid email address is required.' });
    }

    // LEG-02/LEG-03 — consent is checked before the account exists, so an
    // account can never exist without a consent record attached to it. The
    // version is validated too: a tab left open across an update must not be
    // able to record consent to text nobody is showing any more.
    const consent = validateAcceptances({
      role,
      moment: 'signup',
      accepted: req.body?.acceptedDocuments,
    });
    if (!consent.ok) {
      return res.status(consent.code === 'terms_version_stale' ? 409 : 400).json({
        error: consent.error,
        code: consent.code,
      });
    }

    const passwordHash = await hashPassword(password);

    const { data: existingUser, error: existingUserError } = await supabase
      .from(TABLES.users)
      .select('id')
      .eq('username', normalized)
      .maybeSingle();
    if (existingUserError) {
      return res.status(500).json({ error: 'Unable to verify existing user.' });
    }
    if (existingUser) {
      return res.status(409).json({ error: 'Username already exists.' });
    }

    const { data: insertedUser, error: insertError } = await supabase
      .from(TABLES.users)
      .insert({
        username: normalized,
        email: normalizedEmail,
        password: passwordHash,
        user_type: toDbUserType(role),
      })
      .select('id, username, user_type')
      .single();

    if (insertError) {
      if (
        typeof insertError.message === 'string' &&
        insertError.message.toLowerCase().includes('row-level security')
      ) {
        return res.status(500).json({
          error:
            'Supabase RLS blocked writes to users. Configure SUPABASE_SERVICE_ROLE_KEY on the backend.',
        });
      }
      if (insertError.code === '23505') {
        return res.status(409).json({ error: 'Username already exists.' });
      }
      return res.status(500).json({ error: insertError.message || 'Signup failed.' });
    }

    const profileError = await createRoleProfile({
      userId: insertedUser.id,
      role,
    });
    if (profileError) {
      await supabase.from(TABLES.users).delete().eq('id', insertedUser.id);
      return res.status(500).json({
        error:
          profileError.message ||
          'Account created but role profile initialization failed.',
      });
    }

    // Consent is written immediately after the account exists, so the record
    // and the account share a lifetime. A failure here does not undo the
    // signup — it is logged, and the gap is closed by hand.
    await recordAcceptances({
      req,
      userId: insertedUser.id,
      documents: consent.documents,
      context: 'signup',
    });

    // Verificarea emailului nu blochează autentificarea deocamdată — trimitem
    // linkul, iar contul rămâne utilizabil. Când vrei să o faci obligatorie,
    // e suficient să verifici email_verified la login.
    try {
      const token = await issueAuthToken({
        userId: insertedUser.id,
        purpose: 'email_verification',
        ttlMs: 24 * 60 * 60 * 1000,
      });
      const link = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/auth/verify-email?token=${token}`;
      await sendMail({
        to: normalizedEmail,
        subject: 'Confirmă adresa de email — Farmables',
        text: `Bine ai venit pe Farmables.\n\nConfirmă adresa de email deschizând linkul de mai jos:\n\n${link}\n\nLinkul e valabil 24 de ore.`,
      });
    } catch (tokenError) {
      console.error('[auth] Unable to send verification email:', tokenError?.message);
    }

    return res.status(201).json(mapDbUserToApi(insertedUser));
  } catch (error) {
    return next(error);
  }
});

router.post('/login', authLimiter, usernameLimiter, async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required.' });
    }

    const normalized = normalizeUsername(username);
    const { data: user, error } = await supabase
      .from(TABLES.users)
      .select('id, username, password, user_type, token_version')
      .eq('username', normalized)
      .maybeSingle();

    // O bază de date căzută sau o migrare nerulată nu au voie să arate ca o
    // parolă greșită: utilizatorul ar căuta la nesfârșit vina în parola lui.
    if (error) {
      console.error('[auth] Login query failed:', error.message);
      return res.status(500).json({
        error: 'Sign-in is temporarily unavailable. The team has been notified.',
      });
    }
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const valid = await verifyPassword(password, user.password);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const apiUser = mapDbUserToApi(user);
    const session = await createSession({
      ...apiUser,
      tokenVersion: Number(user.token_version || 0),
    });

    res.cookie(SESSION_COOKIE_NAME, session.token, sessionCookieOptions());

    return res.json(apiUser);
  } catch (error) {
    return next(error);
  }
});

router.get('/me', async (req, res, next) => {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    return res.json({
      id: user.id,
      username: user.username,
      role: user.role,
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/change-password', requireAuth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};

    if (typeof currentPassword !== 'string' || !currentPassword) {
      return res.status(400).json({ error: 'Current password is required.' });
    }
    const passwordProblem = validatePassword(newPassword, { username: req.user.username });
    if (passwordProblem) {
      return res.status(400).json({ error: passwordProblem });
    }
    if (newPassword === currentPassword) {
      return res.status(400).json({ error: 'The new password must be different from the current one.' });
    }

    const { data: user, error } = await supabase
      .from(TABLES.users)
      .select('id, password')
      .eq('id', req.user.id)
      .maybeSingle();
    if (error || !user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const valid = await verifyPassword(currentPassword, user.password);
    if (!valid) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }

    const passwordHash = await hashPassword(newPassword);
    const { error: updateError } = await supabase
      .from(TABLES.users)
      .update({ password: passwordHash })
      .eq('id', user.id);
    if (updateError) {
      return res.status(500).json({ error: updateError.message || 'Unable to change password.' });
    }

    // SEC-08: schimbarea parolei dă afară orice altă sesiune, inclusiv a unui
    // atacator care ar fi furat cookie-ul. Apoi ne reemitem propria sesiune,
    // ca utilizatorul care tocmai și-a schimbat parola să rămână logat.
    await revokeUserSessions(user.id);
    await recordAudit({
      req,
      actorType: 'user',
      actorId: user.id,
      action: ACTIONS.PASSWORD_CHANGED,
      entityType: 'user',
      entityId: user.id,
    });

    const session = await createSession({
      id: req.user.id,
      role: req.user.role,
      tokenVersion: Number(req.user.tokenVersion || 0) + 1,
    });
    res.cookie(SESSION_COOKIE_NAME, session.token, sessionCookieOptions());

    return res.json({ changed: true, otherSessionsRevoked: true });
  } catch (error) {
    return next(error);
  }
});

router.post('/forgot-password', authLimiter, usernameLimiter, async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const username = normalizeUsername(req.body?.username || '');

    if (!email && !username) {
      return res.status(400).json({ error: 'Email or username is required.' });
    }

    let query = supabase.from(TABLES.users).select('id, username, email');
    query = email ? query.eq('email', email) : query.eq('username', username);
    const { data: user } = await query.maybeSingle();

    // Răspuns identic indiferent dacă adresa există: altfel ruta devine un
    // oracol prin care se pot enumera conturile.
    if (user?.id && user.email) {
      try {
        const token = await issueAuthToken({
          userId: user.id,
          purpose: 'password_reset',
          ttlMs: RESET_TOKEN_TTL_MS,
        });
        const link = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/auth/reset-password?token=${token}`;
        await sendMail({
          to: user.email,
          subject: 'Resetare parolă — Farmables',
          text: `Am primit o cerere de resetare a parolei pentru contul ${user.username}.\n\nDeschide linkul de mai jos ca să alegi o parolă nouă:\n\n${link}\n\nLinkul e valabil 30 de minute și poate fi folosit o singură dată.\nDacă nu tu ai cerut resetarea, ignoră mesajul — parola rămâne neschimbată.`,
        });
      } catch (tokenError) {
        console.error('[auth] Unable to issue reset token:', tokenError?.message);
      }
    }

    return res.json({
      sent: true,
      message: 'If that account exists, a reset link is on its way.',
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/reset-password', authLimiter, async (req, res, next) => {
  try {
    const { token, newPassword } = req.body || {};

    const passwordProblem = validatePassword(newPassword);
    if (passwordProblem) {
      return res.status(400).json({ error: passwordProblem });
    }

    const consumed = await consumeAuthToken(token, 'password_reset');
    if (!consumed) {
      return res.status(400).json({ error: 'This reset link is invalid or has expired.' });
    }

    const passwordHash = await hashPassword(newPassword);
    const { error: updateError } = await supabase
      .from(TABLES.users)
      .update({ password: passwordHash })
      .eq('id', consumed.userId);
    if (updateError) {
      return res.status(500).json({ error: 'Unable to reset password.' });
    }

    // Resetarea presupune că parola veche e compromisă: dăm afară tot.
    await revokeUserSessions(consumed.userId);
    await recordAudit({
      req,
      actorType: 'user',
      actorId: consumed.userId,
      action: ACTIONS.PASSWORD_RESET,
      entityType: 'user',
      entityId: consumed.userId,
    });

    return res.json({ reset: true });
  } catch (error) {
    return next(error);
  }
});

router.post('/verify-email', authLimiter, async (req, res, next) => {
  try {
    const consumed = await consumeAuthToken(req.body?.token, 'email_verification');
    if (!consumed) {
      return res.status(400).json({ error: 'This verification link is invalid or has expired.' });
    }

    const { error } = await supabase
      .from(TABLES.users)
      .update({ email_verified: true })
      .eq('id', consumed.userId);
    if (error) {
      return res.status(500).json({ error: 'Unable to verify email.' });
    }

    return res.json({ verified: true });
  } catch (error) {
    return next(error);
  }
});

router.post('/logout', async (req, res, next) => {
  try {
    const user = await getUserFromRequest(req);
    if (user) {
      // SEC-08: delogarea invalidează tokenul pe server, nu doar în browser.
      await revokeUserSessions(user.id);
      await recordAudit({
        req,
        actorType: 'user',
        actorId: user.id,
        action: ACTIONS.SESSIONS_REVOKED,
        entityType: 'user',
        entityId: user.id,
      });
    }

    res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    return res.status(204).end();
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
