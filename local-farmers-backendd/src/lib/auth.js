const crypto = require('crypto');
const { promisify } = require('util');

const { SESSION_SECRET } = require('./config');

const scryptAsync = promisify(crypto.scrypt);

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const SESSION_COOKIE_NAME = 'lf_session';

const hashPassword = async (password) => {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = await scryptAsync(password, salt, 64);
  return `${salt}:${derivedKey.toString('hex')}`;
};

const verifyPassword = async (password, storedHash) => {
  if (!storedHash || !storedHash.includes(':')) {
    return false;
  }
  const [salt, key] = storedHash.split(':');
  if (!salt || !key) {
    return false;
  }

  const derivedKey = await scryptAsync(password, salt, 64);
  const keyBuffer = Buffer.from(key, 'hex');
  if (keyBuffer.length !== derivedKey.length) {
    return false;
  }
  return crypto.timingSafeEqual(keyBuffer, derivedKey);
};

const base64UrlEncode = (value) =>
  Buffer.from(value, 'utf8').toString('base64url');
const base64UrlDecode = (value) =>
  Buffer.from(value, 'base64url').toString('utf8');

const signValue = (value) =>
  crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');

const createSession = async (user) => {
  const now = Date.now();
  const payload = {
    userId: String(user.id),
    role: user.role,
    exp: now + SESSION_TTL_MS,
  };

  const payloadSegment = base64UrlEncode(JSON.stringify(payload));
  const signature = signValue(payloadSegment);
  return {
    token: `${payloadSegment}.${signature}`,
    expiresAt: new Date(payload.exp).toISOString(),
  };
};

const getSession = async (token) => {
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
    if (!payload?.userId || !payload?.exp) {
      return null;
    }
    if (Date.now() >= Number(payload.exp)) {
      return null;
    }

    return {
      userId: String(payload.userId),
      role: payload.role || null,
      expiresAt: new Date(Number(payload.exp)).toISOString(),
    };
  } catch (_error) {
    return null;
  }
};

const revokeSession = async () => null;

module.exports = {
  SESSION_TTL_MS,
  SESSION_COOKIE_NAME,
  hashPassword,
  verifyPassword,
  createSession,
  getSession,
  revokeSession,
};
