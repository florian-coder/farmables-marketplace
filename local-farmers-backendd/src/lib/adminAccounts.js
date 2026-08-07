// SEC-12 — admins as people, not as one shared password.
//
// What the shared credential cost, beyond the obvious:
//
//   * every audit entry named the same actor, so "who approved this farm"
//     had no answer;
//   * revoking one person meant changing the password for everyone;
//   * a leak was undetectable, because there was nothing to detect.
//
// And the specific problem: **the current password is in git history.** It
// must be treated as public. So the environment credential survives only as a
// bootstrap — it can create the first `admin_users` row and nothing else, and
// that row cannot do anything until it has enrolled in TOTP.
//
// TOTP notes worth keeping:
//
//   * `last_totp_step` is not optional. Without it a code stays valid for its
//     whole window, so anyone who sees a code over someone's shoulder — or in
//     a screen share — can reuse it. Recording the step consumed makes each
//     code single-use.
//   * One step of drift either side. That is ±30 seconds, which covers a
//     phone with a slightly wrong clock without meaningfully widening the
//     window.
//   * Backup codes are hashed with SHA-256, not scrypt. They are 40 bits of
//     real randomness rather than something a human chose, so there is no
//     dictionary to slow down and nothing a slow hash buys.

const crypto = require('crypto');
// otplib is pinned to v12 on purpose: v13 ships its base32 dependency as
// ESM only, which Jest cannot require from a CommonJS test. Same RFC 6238,
// same codes, and it loads everywhere this project runs.
const { authenticator } = require('otplib');

const { supabase, TABLES } = require('./supabase');
const { hashPassword, verifyPassword } = require('./auth');
const {
  ADMIN_USERNAME,
  ADMIN_PASSWORD,
  ADMIN_BOOTSTRAP_DISABLED,
  OPERATOR_BRAND,
} = require('./config');

/** Failures before the account locks. Cleared by another admin, not by time. */
const MAX_FAILED_ATTEMPTS = 5;

/** How many backup codes are issued at enrolment. */
const BACKUP_CODE_COUNT = 10;

const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;

const normalizeUsername = (value) => String(value || '').trim().toLowerCase().slice(0, 64);

const hashBackupCode = (code) =>
  crypto.createHash('sha256').update(String(code).trim().toUpperCase()).digest('hex');

/** `A3F9-2K7M` — readable over the phone, no ambiguous characters. */
const generateBackupCode = () => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const pick = () => alphabet[crypto.randomInt(0, alphabet.length)];
  return `${pick()}${pick()}${pick()}${pick()}-${pick()}${pick()}${pick()}${pick()}`;
};

/** The 30-second window a timestamp falls in. Used for replay protection. */
const currentTotpStep = (at = Date.now()) => Math.floor(at / 1000 / TOTP_PERIOD_SECONDS);

const findAdmin = async (username) => {
  const { data, error } = await supabase
    .from(TABLES.adminUsers)
    .select(
      'id, username, password_hash, totp_secret, totp_enrolled_at, last_totp_step, is_active, locked_at, failed_attempts',
    )
    .eq('username', normalizeUsername(username))
    .maybeSingle();

  if (error) {
    throw new Error(error.message || 'Unable to load admin account.');
  }
  return data || null;
};

const countAdmins = async () => {
  const { data, error } = await supabase.from(TABLES.adminUsers).select('id');
  if (error) {
    return 0;
  }
  return Array.isArray(data) ? data.length : 0;
};

/**
 * Create the first admin from the environment credential.
 *
 * Only ever runs when `admin_users` is empty, and the row it creates has no
 * TOTP secret — so the very next thing that account must do is enrol. Once
 * anyone has enrolled, set `ADMIN_BOOTSTRAP_DISABLED=1` and this path is dead.
 */
const bootstrapFirstAdmin = async ({ username, password }) => {
  if (ADMIN_BOOTSTRAP_DISABLED) {
    return null;
  }
  if (normalizeUsername(username) !== normalizeUsername(ADMIN_USERNAME)) {
    return null;
  }
  if (password !== ADMIN_PASSWORD) {
    return null;
  }
  if ((await countAdmins()) > 0) {
    // Someone has already been created. The environment credential is in git
    // history; it does not get a second chance.
    return null;
  }

  const { data, error } = await supabase
    .from(TABLES.adminUsers)
    .insert({
      username: normalizeUsername(ADMIN_USERNAME),
      password_hash: await hashPassword(ADMIN_PASSWORD),
      is_active: true,
    })
    .select('id, username, password_hash, totp_secret, totp_enrolled_at, is_active, locked_at, failed_attempts')
    .single();

  if (error) {
    console.error('[admin] Bootstrap failed:', error.message);
    return null;
  }

  console.warn(
    '[admin] Bootstrapped the first admin account from the environment credential. ' +
      'Enrol in TOTP now, then set ADMIN_BOOTSTRAP_DISABLED=1 — that password is in git history.',
  );
  return data;
};

const recordFailure = async (admin) => {
  const attempts = Number(admin.failed_attempts || 0) + 1;
  const patch = { failed_attempts: attempts };
  if (attempts >= MAX_FAILED_ATTEMPTS) {
    // Locked until another admin clears it. Not a timeout: an attacker with
    // patience beats a timeout, and a locked colleague is a two-minute
    // conversation.
    patch.locked_at = new Date().toISOString();
  }
  await supabase.from(TABLES.adminUsers).update(patch).eq('id', admin.id);
  return attempts >= MAX_FAILED_ATTEMPTS;
};

const recordSuccess = async ({ admin, ip, totpStep }) => {
  const patch = {
    failed_attempts: 0,
    last_login_at: new Date().toISOString(),
    last_login_ip: String(ip || '').slice(0, 60),
  };
  if (totpStep !== undefined && totpStep !== null) {
    patch.last_totp_step = totpStep;
  }
  await supabase.from(TABLES.adminUsers).update(patch).eq('id', admin.id);
};

/**
 * Check a TOTP code, and refuse one that has already been used.
 *
 * Returns `{ ok, step }` or `{ ok: false, reason }`.
 */
const verifyTotp = ({ secret, token, lastStep }) => {
  const code = String(token || '').replace(/\s+/g, '');
  if (!secret || !/^\d{6}$/.test(code)) {
    return { ok: false, reason: 'malformed' };
  }

  const totp = authenticator.clone({
    digits: TOTP_DIGITS,
    step: TOTP_PERIOD_SECONDS,
    // One step either side: ±30 seconds of clock drift, which covers a phone
    // with a slightly wrong clock without meaningfully widening the window.
    window: 1,
  });

  if (!totp.check(code, secret)) {
    return { ok: false, reason: 'invalid' };
  }

  // Which step the code actually belongs to. `check` accepts three, so we
  // find the one that matched in order to record it as spent.
  const now = currentTotpStep();
  let step = now;
  for (const candidate of [now, now - 1, now + 1]) {
    const expected = totp.generate(secret, candidate * TOTP_PERIOD_SECONDS * 1000);
    if (expected === code) {
      step = candidate;
      break;
    }
  }

  if (lastStep !== null && lastStep !== undefined && step <= Number(lastStep)) {
    // Already spent. Without this check, a code anyone glimpsed — over a
    // shoulder, in a screen share — stays usable for its whole window, which
    // makes TOTP a 30-second password.
    return { ok: false, reason: 'replayed' };
  }

  return { ok: true, step };
};

/** Spend a backup code. Marked used rather than deleted: the trail matters. */
const consumeBackupCode = async ({ adminId, code, ip }) => {
  const hash = hashBackupCode(code);

  const { data: row, error } = await supabase
    .from(TABLES.adminBackupCodes)
    .select('id, admin_id, used_at')
    .eq('code_hash', hash)
    .maybeSingle();

  if (error || !row || String(row.admin_id) !== String(adminId) || row.used_at) {
    return false;
  }

  const { data: updated, error: useError } = await supabase
    .from(TABLES.adminBackupCodes)
    .update({ used_at: new Date().toISOString(), used_ip: String(ip || '').slice(0, 60) })
    .eq('id', row.id)
    // Only if still unused: two simultaneous attempts must not both succeed.
    .is('used_at', null)
    .select('id');

  return Array.isArray(updated) ? updated.length > 0 : !useError;
};

/**
 * Issue a fresh set of backup codes, replacing any that exist.
 *
 * The plaintext is returned exactly once — this call — and never stored. If
 * the admin loses them, they generate a new set; we genuinely cannot help.
 */
const issueBackupCodes = async (adminId) => {
  await supabase.from(TABLES.adminBackupCodes).delete().eq('admin_id', String(adminId));

  const codes = Array.from({ length: BACKUP_CODE_COUNT }, generateBackupCode);
  const { error } = await supabase.from(TABLES.adminBackupCodes).insert(
    codes.map((code) => ({
      admin_id: String(adminId),
      code_hash: hashBackupCode(code),
    })),
  );

  if (error) {
    throw new Error(error.message || 'Unable to issue backup codes.');
  }
  return codes;
};

/** Start enrolment: a secret and the URI an authenticator app scans. */
const beginTotpEnrolment = async (admin) => {
  const secret = authenticator.generateSecret();

  const { error } = await supabase
    .from(TABLES.adminUsers)
    // Written before it is confirmed, but `totp_enrolled_at` stays null, so
    // the secret cannot be used to sign in until a code proves the app has it.
    .update({ totp_secret: secret })
    .eq('id', admin.id);

  if (error) {
    throw new Error(error.message || 'Unable to start enrolment.');
  }

  return {
    secret,
    uri: authenticator.keyuri(admin.username, OPERATOR_BRAND, secret),
  };
};

/** Confirm enrolment with a code from the app, and hand over backup codes. */
const completeTotpEnrolment = async ({ admin, token }) => {
  if (!admin.totp_secret) {
    return { ok: false, reason: 'not_started' };
  }

  const check = verifyTotp({ secret: admin.totp_secret, token, lastStep: null });
  if (!check.ok) {
    return { ok: false, reason: check.reason };
  }

  const { error } = await supabase
    .from(TABLES.adminUsers)
    .update({ totp_enrolled_at: new Date().toISOString(), last_totp_step: check.step })
    .eq('id', admin.id);

  if (error) {
    return { ok: false, reason: 'save_failed' };
  }

  const codes = await issueBackupCodes(admin.id);
  return { ok: true, backupCodes: codes };
};

/**
 * The whole sign-in decision, in one place.
 *
 * Returns `{ ok: true, admin, needsEnrolment }` or a refusal with a `reason`
 * the route maps to a status. The route deliberately does not know the rules.
 */
const authenticateAdmin = async ({ username, password, token, backupCode, ip }) => {
  let admin = await findAdmin(username);

  if (!admin) {
    admin = await bootstrapFirstAdmin({ username, password });
    if (!admin) {
      return { ok: false, reason: 'invalid_credentials' };
    }
    // A freshly bootstrapped account: password checked already, no TOTP yet.
    return { ok: true, admin, needsEnrolment: true };
  }

  if (!admin.is_active) {
    return { ok: false, reason: 'disabled' };
  }
  if (admin.locked_at) {
    return { ok: false, reason: 'locked' };
  }

  const passwordOk = await verifyPassword(password, admin.password_hash);
  if (!passwordOk) {
    const locked = await recordFailure(admin);
    return { ok: false, reason: locked ? 'locked' : 'invalid_credentials' };
  }

  // Enrolled once, required forever. An account that has enrolled cannot go
  // back to password-only by clearing its own secret.
  if (!admin.totp_enrolled_at) {
    return { ok: true, admin, needsEnrolment: true };
  }

  if (backupCode) {
    const used = await consumeBackupCode({ adminId: admin.id, code: backupCode, ip });
    if (!used) {
      const locked = await recordFailure(admin);
      return { ok: false, reason: locked ? 'locked' : 'invalid_second_factor' };
    }
    await recordSuccess({ admin, ip });
    return { ok: true, admin, needsEnrolment: false, usedBackupCode: true };
  }

  const check = verifyTotp({
    secret: admin.totp_secret,
    token,
    lastStep: admin.last_totp_step,
  });
  if (!check.ok) {
    const locked = await recordFailure(admin);
    return {
      ok: false,
      reason: locked ? 'locked' : check.reason === 'replayed' ? 'code_already_used' : 'invalid_second_factor',
    };
  }

  await recordSuccess({ admin, ip, totpStep: check.step });
  return { ok: true, admin, needsEnrolment: false };
};

module.exports = {
  MAX_FAILED_ATTEMPTS,
  BACKUP_CODE_COUNT,
  TOTP_PERIOD_SECONDS,
  normalizeUsername,
  hashBackupCode,
  generateBackupCode,
  currentTotpStep,
  findAdmin,
  countAdmins,
  verifyTotp,
  consumeBackupCode,
  issueBackupCodes,
  beginTotpEnrolment,
  completeTotpEnrolment,
  authenticateAdmin,
};
