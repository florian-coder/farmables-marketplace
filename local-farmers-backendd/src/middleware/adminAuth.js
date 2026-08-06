const crypto = require('crypto');

const {
  ADMIN_PASSWORD,
  ADMIN_SESSION_SECRET,
  ADMIN_USERNAME,
} = require('../lib/config');

const ADMIN_COOKIE_NAME = 'lf_admin_session';
const ADMIN_SESSION_TTL_MS = 1000 * 60 * 60 * 12;

/**
 * Comparație în timp constant, ca durata răspunsului să nu spună atacatorului
 * câte caractere din parolă a nimerit.
 */
const safeEquals = (left, right) => {
  const a = Buffer.from(String(left ?? ''), 'utf8');
  const b = Buffer.from(String(right ?? ''), 'utf8');
  if (a.length !== b.length) {
    // Comparăm oricum, cu b față de el însuși, ca să nu revenim mai devreme.
    crypto.timingSafeEqual(b, b);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
};

const verifyAdminCredentials = (username, password) =>
  safeEquals(username, ADMIN_USERNAME) && safeEquals(password, ADMIN_PASSWORD);

const base64UrlEncode = (value) =>
  Buffer.from(value, 'utf8').toString('base64url');
const base64UrlDecode = (value) =>
  Buffer.from(value, 'base64url').toString('utf8');

const signValue = (value) =>
  crypto
    .createHmac('sha256', ADMIN_SESSION_SECRET)
    .update(value)
    .digest('base64url');

const createAdminSessionToken = () => {
  const payload = {
    username: ADMIN_USERNAME,
    exp: Date.now() + ADMIN_SESSION_TTL_MS,
  };

  const payloadSegment = base64UrlEncode(JSON.stringify(payload));
  const signature = signValue(payloadSegment);
  return `${payloadSegment}.${signature}`;
};

const getAdminSession = (token) => {
  if (!token || typeof token !== 'string' || !token.includes('.')) {
    return null;
  }

  const [payloadSegment, signature] = token.split('.');
  if (!payloadSegment || !signature) {
    return null;
  }

  const expectedSignature = signValue(payloadSegment);
  const expectedBuffer = Buffer.from(expectedSignature);
  const signatureBuffer = Buffer.from(signature);
  if (
    expectedBuffer.length !== signatureBuffer.length ||
    !crypto.timingSafeEqual(expectedBuffer, signatureBuffer)
  ) {
    return null;
  }

  try {
    const payloadRaw = base64UrlDecode(payloadSegment);
    const payload = JSON.parse(payloadRaw);
    if (!payload?.username || !payload?.exp) {
      return null;
    }
    if (payload.username !== ADMIN_USERNAME) {
      return null;
    }
    if (Date.now() >= Number(payload.exp)) {
      return null;
    }

    return {
      username: payload.username,
      expiresAt: new Date(Number(payload.exp)).toISOString(),
    };
  } catch (_error) {
    return null;
  }
};

const requireAdmin = (req, res, next) => {
  const token = req.cookies?.[ADMIN_COOKIE_NAME];
  const session = getAdminSession(token);
  if (!session) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  req.admin = session;
  return next();
};

module.exports = {
  ADMIN_COOKIE_NAME,
  ADMIN_SESSION_TTL_MS,
  ADMIN_USERNAME,
  createAdminSessionToken,
  getAdminSession,
  requireAdmin,
  verifyAdminCredentials,
};
