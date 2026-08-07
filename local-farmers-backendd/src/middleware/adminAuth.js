// SEC-12 — admin sessions that name a person.
//
// The session token now carries the `admin_users` row id and a session id, so
// every audit entry says who, and one person's access can be revoked without
// changing anyone else's password.
//
// Two changes worth calling out:
//
//   * **8 hours, down from 12.** The spec asked for a maximum of 8, and an
//     admin session is the most valuable cookie in the system — it can refund
//     money and suspend farms. A working day is the longest defensible window.
//
//   * **A second, unenrolled session kind.** Someone who has just bootstrapped
//     has a password and no TOTP. They need *something* to hold while they
//     enrol, but that something must not open the panel. `scope: 'enrol'` can
//     reach the two enrolment routes and nothing else.

const crypto = require('crypto');

const { ADMIN_SESSION_SECRET, ADMIN_IP_ALLOWLIST } = require('../lib/config');

const ADMIN_COOKIE_NAME = 'lf_admin_session';
/** SEC-12 — a working day, and not a minute more. */
const ADMIN_SESSION_TTL_MS = 1000 * 60 * 60 * 8;

const SCOPES = Object.freeze({
  /** Full access to the panel. Requires a completed second factor. */
  FULL: 'full',
  /** Password accepted, TOTP not enrolled. Enrolment routes only. */
  ENROL: 'enrol',
});

const base64UrlEncode = (value) => Buffer.from(value, 'utf8').toString('base64url');
const base64UrlDecode = (value) => Buffer.from(value, 'base64url').toString('utf8');

const signValue = (value) =>
  crypto.createHmac('sha256', ADMIN_SESSION_SECRET).update(value).digest('base64url');

/**
 * Mint a session for one specific admin.
 *
 * `sid` is a per-session id so an individual sign-in can be identified in the
 * audit log — two browsers for the same person are two sessions, and telling
 * them apart matters when one of them turns out to be someone else.
 */
const createAdminSessionToken = ({ adminId, username, scope = SCOPES.FULL }) => {
  const payload = {
    sub: String(adminId),
    username: String(username),
    scope,
    sid: crypto.randomUUID(),
    exp: Date.now() + ADMIN_SESSION_TTL_MS,
  };

  const payloadSegment = base64UrlEncode(JSON.stringify(payload));
  return `${payloadSegment}.${signValue(payloadSegment)}`;
};

const getAdminSession = (token) => {
  if (!token || typeof token !== 'string' || !token.includes('.')) {
    return null;
  }

  const [payloadSegment, signature] = token.split('.');
  if (!payloadSegment || !signature) {
    return null;
  }

  const expected = Buffer.from(signValue(payloadSegment));
  const provided = Buffer.from(signature);
  if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) {
    return null;
  }

  try {
    const payload = JSON.parse(base64UrlDecode(payloadSegment));
    if (!payload?.sub || !payload?.exp || !payload?.username) {
      return null;
    }
    if (Date.now() >= Number(payload.exp)) {
      return null;
    }

    return {
      adminId: String(payload.sub),
      username: String(payload.username),
      scope: payload.scope === SCOPES.ENROL ? SCOPES.ENROL : SCOPES.FULL,
      sessionId: String(payload.sid || ''),
      expiresAt: new Date(Number(payload.exp)).toISOString(),
    };
  } catch (_error) {
    return null;
  }
};

/**
 * Optional IP allowlist.
 *
 * Empty means unrestricted, deliberately: an allowlist that locks out the only
 * admin is worse than no allowlist. Prefix matching so a `/24` can be written
 * as `203.0.113.` without pulling in a CIDR library for a feature most
 * deployments will leave off.
 */
const ipAllowed = (req) => {
  if (ADMIN_IP_ALLOWLIST.length === 0) {
    return true;
  }
  const ip = String(req?.ip || req?.socket?.remoteAddress || '');
  return ADMIN_IP_ALLOWLIST.some((entry) => ip === entry || ip.startsWith(entry));
};

const requireAdmin = (req, res, next) => {
  if (!ipAllowed(req)) {
    // Deliberately indistinguishable from a bad cookie: an attacker probing
    // from the wrong network learns nothing about whether an allowlist exists.
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const session = getAdminSession(req.cookies?.[ADMIN_COOKIE_NAME]);
  if (!session) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (session.scope !== SCOPES.FULL) {
    return res.status(403).json({
      error: 'Finish setting up two-factor authentication before using the panel.',
      code: 'totp_enrolment_required',
    });
  }

  req.admin = session;
  return next();
};

/** For the enrolment routes only: a password-only session is enough there. */
const requireAdminEnrolling = (req, res, next) => {
  if (!ipAllowed(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const session = getAdminSession(req.cookies?.[ADMIN_COOKIE_NAME]);
  if (!session) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  req.admin = session;
  return next();
};

module.exports = {
  ADMIN_COOKIE_NAME,
  ADMIN_SESSION_TTL_MS,
  SCOPES,
  createAdminSessionToken,
  getAdminSession,
  ipAllowed,
  requireAdmin,
  requireAdminEnrolling,
};
