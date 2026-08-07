// SEC-12 — admin hardening.
//
// The finding: one shared credential from the environment, no 2FA, no
// per-admin identity — and **that password is in git history**, so it has to
// be treated as public.
//
// What these cover, in order of how much they would cost to get wrong:
//   1. the environment credential can bootstrap exactly one account, once;
//   2. an enrolled account can never sign in with a password alone again;
//   3. a TOTP code cannot be replayed inside its own window;
//   4. an audit entry names a person.

const request = require('supertest');
const { authenticator } = require('otplib');

const { buildApp, browserHeaders, adminCookie } = require('../helpers/appHarness');
const { hashPassword } = require('../../src/lib/auth');
const { hashBackupCode, verifyTotp, currentTotpStep } = require('../../src/lib/adminAccounts');
const { SCOPES } = require('../../src/middleware/adminAuth');

const PASSWORD = 'admin-parola-lunga';
const SECRET = authenticator.generateSecret();
const codeNow = () => authenticator.generate(SECRET);

const enrolledAdmin = async (overrides = {}) => ({
  id: 'admin-1',
  username: 'ana.admin',
  password_hash: await hashPassword(PASSWORD),
  totp_secret: SECRET,
  totp_enrolled_at: '2026-07-01T00:00:00.000Z',
  last_totp_step: null,
  is_active: true,
  locked_at: null,
  failed_attempts: 0,
  ...overrides,
});

const seed = async (admins = []) => ({
  admin_users: admins,
  admin_backup_codes: [],
  audit_log: [],
});

const login = (app, body) =>
  request(app).post('/api/admin/login').set(browserHeaders).send(body);

describe('SEC-12 — the environment credential is a bootstrap, not a login', () => {
  test('creates the first admin, and immediately demands enrolment', async () => {
    const { app, fake } = buildApp(await seed([]));

    const response = await login(app, {
      username: 'test-admin',
      password: 'test-admin-password',
    });

    expect(response.status).toBe(200);
    // Not authenticated: a password alone opens nothing.
    expect(response.body.authenticated).toBe(false);
    expect(response.body.enrolmentRequired).toBe(true);

    const created = fake._db.admin_users[0];
    expect(created.username).toBe('test-admin');
    // No secret yet, so the account cannot yet do anything.
    expect(created.totp_enrolled_at).toBeUndefined();
  });

  test('never works a second time', async () => {
    // The password is in git history. One account, then it is dead.
    const { app } = buildApp(await seed([await enrolledAdmin()]));

    const response = await login(app, {
      username: 'test-admin',
      password: 'test-admin-password',
    });

    expect(response.status).toBe(401);
  });

  test('a bootstrap session cannot reach the panel', async () => {
    const { app } = buildApp(await seed([await enrolledAdmin()]));

    const response = await request(app)
      .get('/api/admin/farmer-requests')
      .set('Cookie', adminCookie({ scope: SCOPES.ENROL }));

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('totp_enrolment_required');
  });
});

describe('SEC-12 — a second factor, every time', () => {
  test('the right password with no code is refused', async () => {
    const { app } = buildApp(await seed([await enrolledAdmin()]));

    const response = await login(app, { username: 'ana.admin', password: PASSWORD });

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('invalid_second_factor');
  });

  test('the right password and the right code signs in', async () => {
    const { app, fake } = buildApp(await seed([await enrolledAdmin()]));

    const response = await login(app, {
      username: 'ana.admin',
      password: PASSWORD,
      token: codeNow(),
    });

    expect(response.status).toBe(200);
    expect(response.body.authenticated).toBe(true);
    expect(response.body.username).toBe('ana.admin');

    // SEC-11: the entry names a person, which a shared credential could never do.
    const entry = fake._db.audit_log.find((row) => row.action === 'admin.login');
    expect(entry.actor_id).toBe('ana.admin');
    expect(entry.new_value).toBe('totp');
  });

  test('the wrong password is refused even with a valid code', async () => {
    const { app } = buildApp(await seed([await enrolledAdmin()]));

    const response = await login(app, {
      username: 'ana.admin',
      password: 'wrong',
      token: codeNow(),
    });

    expect(response.status).toBe(401);
  });

  test('a code cannot be used twice inside its own window', async () => {
    // Without replay protection a code anyone glimpsed — over a shoulder, in
    // a screen share — stays usable for its whole window. That is a
    // 30-second password, not a second factor.
    const { app } = buildApp(await seed([await enrolledAdmin()]));
    const code = codeNow();

    const first = await login(app, { username: 'ana.admin', password: PASSWORD, token: code });
    expect(first.status).toBe(200);

    const second = await login(app, { username: 'ana.admin', password: PASSWORD, token: code });
    expect(second.status).toBe(401);
    expect(second.body.code).toBe('code_already_used');
  });

  test('records the step that was spent', async () => {
    const { app, fake } = buildApp(await seed([await enrolledAdmin()]));

    await login(app, { username: 'ana.admin', password: PASSWORD, token: codeNow() });

    const admin = fake._db.admin_users[0];
    expect(Number(admin.last_totp_step)).toBe(currentTotpStep());
  });
});

describe('SEC-12 — verifyTotp in isolation', () => {
  test('accepts a current code and rejects a wrong one', () => {
    expect(verifyTotp({ secret: SECRET, token: codeNow(), lastStep: null }).ok).toBe(true);
    expect(verifyTotp({ secret: SECRET, token: '000000', lastStep: null }).ok).toBe(false);
  });

  test('rejects anything that is not six digits, before doing crypto', () => {
    for (const token of ['', '12345', '1234567', 'abcdef', null, undefined]) {
      expect(verifyTotp({ secret: SECRET, token, lastStep: null }).reason).toBe('malformed');
    }
  });

  test('rejects a step already spent', () => {
    const result = verifyTotp({ secret: SECRET, token: codeNow(), lastStep: currentTotpStep() });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('replayed');
  });

  test('refuses when there is no secret at all', () => {
    expect(verifyTotp({ secret: null, token: '123456', lastStep: null }).ok).toBe(false);
  });
});

describe('SEC-12 — backup codes', () => {
  test('a valid code signs in and is spent', async () => {
    const admin = await enrolledAdmin();
    const data = await seed([admin]);
    data.admin_backup_codes = [
      { id: 'bc-1', admin_id: 'admin-1', code_hash: hashBackupCode('ABCD-2345'), used_at: null },
    ];
    const { app, fake } = buildApp(data);

    const response = await login(app, {
      username: 'ana.admin',
      password: PASSWORD,
      backupCode: 'ABCD-2345',
    });

    expect(response.status).toBe(200);
    expect(response.body.usedBackupCode).toBe(true);
    // Marked used rather than deleted: "this code was used, at this time" is
    // worth more in an incident than a clean table.
    expect(fake._db.admin_backup_codes[0].used_at).toBeTruthy();
  });

  test('the same code does not work twice', async () => {
    const data = await seed([await enrolledAdmin()]);
    data.admin_backup_codes = [
      { id: 'bc-1', admin_id: 'admin-1', code_hash: hashBackupCode('ABCD-2345'), used_at: null },
    ];
    const { app } = buildApp(data);

    await login(app, { username: 'ana.admin', password: PASSWORD, backupCode: 'ABCD-2345' });
    const second = await login(app, {
      username: 'ana.admin',
      password: PASSWORD,
      backupCode: 'ABCD-2345',
    });

    expect(second.status).toBe(401);
  });

  test('another admin’s code does not work', async () => {
    const data = await seed([await enrolledAdmin()]);
    data.admin_backup_codes = [
      { id: 'bc-1', admin_id: 'admin-OTHER', code_hash: hashBackupCode('ABCD-2345'), used_at: null },
    ];
    const { app } = buildApp(data);

    const response = await login(app, {
      username: 'ana.admin',
      password: PASSWORD,
      backupCode: 'ABCD-2345',
    });

    expect(response.status).toBe(401);
  });

  test('is stored only as a hash', async () => {
    const data = await seed([await enrolledAdmin()]);
    data.admin_backup_codes = [
      { id: 'bc-1', admin_id: 'admin-1', code_hash: hashBackupCode('ABCD-2345'), used_at: null },
    ];
    const { fake } = buildApp(data);

    const stored = JSON.stringify(fake._db.admin_backup_codes);
    expect(stored).not.toContain('ABCD-2345');
  });
});

describe('SEC-12 — locking out an attacker', () => {
  test('locks the account after five failures, and says so', async () => {
    const { app, fake } = buildApp(await seed([await enrolledAdmin()]));

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await login(app, { username: 'ana.admin', password: 'wrong' });
      expect(response.status).toBe(401);
    }

    const fifth = await login(app, { username: 'ana.admin', password: 'wrong' });
    expect(fifth.status).toBe(423);
    expect(fake._db.admin_users[0].locked_at).toBeTruthy();
  });

  test('a locked account is refused even with the right credentials', async () => {
    // Cleared by another admin, never by waiting: an attacker with patience
    // beats a timeout, and a locked colleague is a two-minute conversation.
    const { app } = buildApp(
      await seed([await enrolledAdmin({ locked_at: '2026-08-01T00:00:00.000Z' })]),
    );

    const response = await login(app, {
      username: 'ana.admin',
      password: PASSWORD,
      token: codeNow(),
    });

    expect(response.status).toBe(423);
  });

  test('a disabled account cannot sign in', async () => {
    const { app } = buildApp(await seed([await enrolledAdmin({ is_active: false })]));

    const response = await login(app, {
      username: 'ana.admin',
      password: PASSWORD,
      token: codeNow(),
    });

    expect(response.status).toBe(403);
  });

  test('a successful sign-in clears the failure count', async () => {
    const { app, fake } = buildApp(await seed([await enrolledAdmin({ failed_attempts: 3 })]));

    await login(app, { username: 'ana.admin', password: PASSWORD, token: codeNow() });

    expect(Number(fake._db.admin_users[0].failed_attempts)).toBe(0);
  });

  test('every failure is recorded, with the reason', async () => {
    const { app, fake } = buildApp(await seed([await enrolledAdmin()]));

    await login(app, { username: 'ana.admin', password: 'wrong' });

    const entry = fake._db.audit_log.find((row) => row.action === 'admin.login_failed');
    expect(entry.actor_id).toBe('ana.admin');
    expect(entry.new_value).toBe('invalid_credentials');
  });
});

describe('SEC-12 — enrolment', () => {
  test('hands over a secret and a URI an app can scan', async () => {
    const { app, fake } = buildApp(
      await seed([await enrolledAdmin({ totp_secret: null, totp_enrolled_at: null })]),
    );

    const response = await request(app)
      .post('/api/admin/2fa/setup')
      .set(browserHeaders)
      .set('Cookie', adminCookie({ username: 'ana.admin', scope: SCOPES.ENROL }))
      .send({});

    expect(response.status).toBe(200);
    expect(response.body.secret).toBeTruthy();
    expect(response.body.uri).toMatch(/^otpauth:\/\/totp\//);
    // The secret is stored, but `totp_enrolled_at` stays null: it cannot be
    // used to sign in until a code proves the app really has it.
    expect(fake._db.admin_users[0].totp_secret).toBe(response.body.secret);
    expect(fake._db.admin_users[0].totp_enrolled_at).toBeNull();
  });

  test('confirming with a real code completes enrolment and issues backup codes', async () => {
    const { app, fake } = buildApp(
      await seed([await enrolledAdmin({ totp_enrolled_at: null })]),
    );

    const response = await request(app)
      .post('/api/admin/2fa/confirm')
      .set(browserHeaders)
      .set('Cookie', adminCookie({ username: 'ana.admin', scope: SCOPES.ENROL }))
      .send({ token: codeNow() });

    expect(response.status).toBe(200);
    expect(response.body.enrolled).toBe(true);
    expect(response.body.backupCodes).toHaveLength(10);
    expect(fake._db.admin_users[0].totp_enrolled_at).toBeTruthy();
    expect(fake._db.admin_backup_codes).toHaveLength(10);
  });

  test('confirming with a wrong code changes nothing', async () => {
    const { app, fake } = buildApp(
      await seed([await enrolledAdmin({ totp_enrolled_at: null })]),
    );

    const response = await request(app)
      .post('/api/admin/2fa/confirm')
      .set(browserHeaders)
      .set('Cookie', adminCookie({ username: 'ana.admin', scope: SCOPES.ENROL }))
      .send({ token: '000000' });

    expect(response.status).toBe(400);
    expect(fake._db.admin_users[0].totp_enrolled_at).toBeNull();
    expect(fake._db.admin_backup_codes).toHaveLength(0);
  });

  test('an already-enrolled account cannot re-enrol from a stolen session', async () => {
    // Otherwise re-enrolling is a way to swap the second factor for one the
    // attacker controls.
    const { app } = buildApp(await seed([await enrolledAdmin()]));

    const response = await request(app)
      .post('/api/admin/2fa/setup')
      .set(browserHeaders)
      .set('Cookie', adminCookie({ username: 'ana.admin', scope: SCOPES.ENROL }))
      .send({});

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('already_enrolled');
  });
});

describe('SEC-12 — the session', () => {
  test('lasts at most eight hours', async () => {
    const { ADMIN_SESSION_TTL_MS } = require('../../src/middleware/adminAuth');
    // An admin session can refund money and suspend farms. A working day is
    // the longest window that is defensible.
    expect(ADMIN_SESSION_TTL_MS).toBe(8 * 60 * 60 * 1000);
  });

  test('names the admin it belongs to', async () => {
    const { app } = buildApp(await seed([await enrolledAdmin()]));

    const response = await request(app)
      .get('/api/admin/session')
      .set('Cookie', adminCookie({ adminId: 'admin-1', username: 'ana.admin' }));

    expect(response.status).toBe(200);
    expect(response.body.username).toBe('ana.admin');
    expect(response.body.twoFactorEnrolled).toBe(true);
  });

  test('a re-signed payload is refused — the signature is over the payload', async () => {
    // The payload is base64url, so it has to be decoded, edited and re-encoded
    // to be tampered with at all. Keeping the original signature is exactly
    // what an attacker who has seen one cookie would try.
    const { app } = buildApp(await seed([await enrolledAdmin()]));
    const cookie = adminCookie({ adminId: 'admin-1', username: 'ana.admin' });

    const raw = cookie.split('=').slice(1).join('=');
    const [payloadSegment, signature] = raw.split('.');
    const payload = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'));
    expect(payload.username).toBe('ana.admin');

    // Promote a bootstrap session to a full one, and become someone else.
    payload.username = 'root.admin';
    payload.scope = 'full';
    payload.exp = Date.now() + 99 * 60 * 60 * 1000;
    const forged = `${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}.${signature}`;

    const response = await request(app)
      .get('/api/admin/session')
      .set('Cookie', `lf_admin_session=${forged}`);

    expect(response.status).toBe(401);
  });

  test('an expired session is refused however well signed', async () => {
    const { app } = buildApp(await seed([await enrolledAdmin()]));
    const { createAdminSessionToken } = require('../../src/middleware/adminAuth');

    const token = createAdminSessionToken({ adminId: 'admin-1', username: 'ana.admin' });
    const [payloadSegment] = token.split('.');
    const payload = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'));
    // Genuinely signed, genuinely ours, genuinely too old.
    expect(payload.exp).toBeGreaterThan(Date.now());

    jest.spyOn(Date, 'now').mockReturnValue(payload.exp + 1000);
    const response = await request(app)
      .get('/api/admin/session')
      .set('Cookie', `lf_admin_session=${token}`);
    Date.now.mockRestore();

    expect(response.status).toBe(401);
  });
});
