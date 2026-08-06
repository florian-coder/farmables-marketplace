// SEC-07 (politica de parole), SEC-08 (revocarea sesiunilor),
// SEC-09 (resetare parolă și verificare email).

const crypto = require('crypto');
const request = require('supertest');

const {
  buildApp,
  browserHeaders,
  sessionCookieFor,
} = require('../helpers/appHarness');

// Parola „corect-cal-baterie" hashuită de codul real, ca login-ul să fie testat
// pe drumul complet, nu cu un hash inventat.
const { hashPassword } = require('../../src/lib/auth');

const seedWith = async (overrides = {}) => ({
  users: [
    {
      id: '11',
      username: 'ana',
      email: 'ana@example.com',
      user_type: 'customer',
      password: await hashPassword('parola-veche-lunga'),
      token_version: 0,
      email_verified: false,
      ...overrides,
    },
  ],
  customers: [{ id: '11', name: 'Ana', surname: 'Popescu' }],
  auth_tokens: [],
  audit_log: [],
});

describe('SEC-07 — politica de parole', () => {
  it.each([
    ['prea scurtă', 'gradinar', 'scurt1'],
    ['din listele scurse', 'gradinar', 'password123'],
    ['conține numele contului', 'gradinar', 'gradinar-2026'],
  ])('respinge o parolă %s', async (_label, username, password) => {
    const { app } = buildApp(await seedWith());

    const response = await request(app)
      .post('/api/auth/signup')
      .send({ username, password, role: 'customer', email: 'nou@example.com' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBeTruthy();
  });

  it('cere o adresă de email validă la înregistrare', async () => {
    const { app } = buildApp(await seedWith());

    const response = await request(app)
      .post('/api/auth/signup')
      .send({ username: 'fara-email', password: 'parola-suficient-de-lunga', role: 'customer' });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/email/i);
  });

  it('acceptă o parolă bună', async () => {
    const { app } = buildApp(await seedWith());

    const response = await request(app).post('/api/auth/signup').send({
      username: 'clientnou',
      password: 'salata-verde-de-gradina',
      role: 'customer',
      email: 'nou@example.com',
    });

    expect(response.status).toBe(201);
  });
});

describe('SEC-08 — sesiunile pot fi invalidate', () => {
  it('un cookie emis cu versiunea veche nu mai e acceptat după revocare', async () => {
    const { app, fake } = buildApp(await seedWith());
    const cookie = await sessionCookieFor({ id: '11', role: 'customer', tokenVersion: 0 });

    const before = await request(app).get('/api/auth/me').set('Cookie', cookie);
    expect(before.status).toBe(200);

    // Cineva incrementează token_version (schimbare de parolă, delogare, admin).
    fake._db.users[0].token_version = 1;

    const after = await request(app).get('/api/auth/me').set('Cookie', cookie);
    expect(after.status).toBe(401);
  });

  it('delogarea invalidează tokenul pe server, nu doar în browser', async () => {
    const { app, fake } = buildApp(await seedWith());
    const cookie = await sessionCookieFor({ id: '11', role: 'customer', tokenVersion: 0 });

    await request(app).post('/api/auth/logout').set('Cookie', cookie).set(browserHeaders);

    expect(fake._db.users[0].token_version).toBe(1);
    // Același cookie, refolosit de pe alt dispozitiv:
    const reused = await request(app).get('/api/auth/me').set('Cookie', cookie);
    expect(reused.status).toBe(401);
  });

  it('schimbarea parolei dă afară celelalte sesiuni, dar o păstrează pe a ta', async () => {
    const { app, fake } = buildApp(await seedWith());
    const stolenCookie = await sessionCookieFor({ id: '11', role: 'customer', tokenVersion: 0 });
    const myCookie = stolenCookie;

    const response = await request(app)
      .post('/api/auth/change-password')
      .set('Cookie', myCookie)
      .set(browserHeaders)
      .send({ currentPassword: 'parola-veche-lunga', newPassword: 'parola-noua-si-lunga' });

    expect(response.status).toBe(200);
    expect(response.body.otherSessionsRevoked).toBe(true);
    expect(fake._db.users[0].token_version).toBe(1);

    // Cookie-ul furat, cu versiunea veche, nu mai trece.
    const attacker = await request(app).get('/api/auth/me').set('Cookie', stolenCookie);
    expect(attacker.status).toBe(401);

    // Iar cel care a schimbat parola a primit cookie nou în răspuns.
    const refreshed = response.headers['set-cookie']?.join(';') || '';
    expect(refreshed).toMatch(/lf_session=/);
  });

  it('scrie schimbarea parolei în jurnalul de audit', async () => {
    const { app, fake } = buildApp(await seedWith());
    const cookie = await sessionCookieFor({ id: '11', role: 'customer', tokenVersion: 0 });

    await request(app)
      .post('/api/auth/change-password')
      .set('Cookie', cookie)
      .set(browserHeaders)
      .send({ currentPassword: 'parola-veche-lunga', newPassword: 'parola-noua-si-lunga' });

    const entry = fake._db.audit_log.find((row) => row.action === 'password.changed');
    expect(entry).toBeTruthy();
    expect(entry.actor_id).toBe('11');
  });
});

describe('SEC-09 — recuperarea parolei', () => {
  const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

  it('nu dezvăluie dacă adresa există', async () => {
    const { app } = buildApp(await seedWith());

    const known = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'ana@example.com' });
    const unknown = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'nimeni@example.com' });

    expect(known.status).toBe(unknown.status);
    expect(known.body).toEqual(unknown.body);
  });

  it('emite un token stocat doar ca hash', async () => {
    const { app, fake } = buildApp(await seedWith());

    await request(app).post('/api/auth/forgot-password').send({ email: 'ana@example.com' });

    expect(fake._db.auth_tokens).toHaveLength(1);
    const stored = fake._db.auth_tokens[0];
    expect(stored.purpose).toBe('password_reset');
    expect(stored.token_hash).toHaveLength(64); // sha256 hex
    expect(stored.used_at).toBeFalsy();
  });

  it('resetează parola, revocă sesiunile și consumă tokenul o singură dată', async () => {
    const seed = await seedWith();
    const token = 'token-de-test-pentru-resetare';
    seed.auth_tokens = [
      {
        id: 'tok-1',
        user_id: '11',
        purpose: 'password_reset',
        token_hash: hashToken(token),
        expires_at: new Date(Date.now() + 60000).toISOString(),
        used_at: null,
      },
    ];
    const { app, fake } = buildApp(seed);
    const oldHash = fake._db.users[0].password;

    const first = await request(app)
      .post('/api/auth/reset-password')
      .send({ token, newPassword: 'o-parola-complet-noua' });

    expect(first.status).toBe(200);
    expect(fake._db.users[0].password).not.toBe(oldHash);
    expect(fake._db.users[0].token_version).toBe(1);

    // Al doilea apel cu același token trebuie respins.
    const second = await request(app)
      .post('/api/auth/reset-password')
      .send({ token, newPassword: 'inca-o-parola-noua' });

    expect(second.status).toBe(400);
  });

  it('respinge un token expirat', async () => {
    const seed = await seedWith();
    const token = 'token-expirat';
    seed.auth_tokens = [
      {
        id: 'tok-2',
        user_id: '11',
        purpose: 'password_reset',
        token_hash: hashToken(token),
        expires_at: new Date(Date.now() - 1000).toISOString(),
        used_at: null,
      },
    ];
    const { app } = buildApp(seed);

    const response = await request(app)
      .post('/api/auth/reset-password')
      .send({ token, newPassword: 'o-parola-complet-noua' });

    expect(response.status).toBe(400);
  });

  it('nu acceptă un token de verificare a emailului la resetarea parolei', async () => {
    const seed = await seedWith();
    const token = 'token-de-alt-tip';
    seed.auth_tokens = [
      {
        id: 'tok-3',
        user_id: '11',
        purpose: 'email_verification',
        token_hash: hashToken(token),
        expires_at: new Date(Date.now() + 60000).toISOString(),
        used_at: null,
      },
    ];
    const { app } = buildApp(seed);

    const response = await request(app)
      .post('/api/auth/reset-password')
      .send({ token, newPassword: 'o-parola-complet-noua' });

    expect(response.status).toBe(400);
  });

  it('impune politica de parole și la resetare', async () => {
    const seed = await seedWith();
    const token = 'token-valid';
    seed.auth_tokens = [
      {
        id: 'tok-4',
        user_id: '11',
        purpose: 'password_reset',
        token_hash: hashToken(token),
        expires_at: new Date(Date.now() + 60000).toISOString(),
        used_at: null,
      },
    ];
    const { app, fake } = buildApp(seed);

    const response = await request(app)
      .post('/api/auth/reset-password')
      .send({ token, newPassword: '12345' });

    expect(response.status).toBe(400);
    // Tokenul nu a fost consumat, deci utilizatorul poate reîncerca.
    expect(fake._db.auth_tokens[0].used_at).toBeFalsy();
  });
});

describe('Diagnosticare — erorile de bază de date nu se maschează', () => {
  it('răspunde 500, nu „parolă greșită", când interogarea eșuează', async () => {
    const { app, fake } = buildApp(await seedWith());

    // Simulează o migrare nerulată: coloana cerută nu există.
    const originalFrom = fake.from;
    fake.from = (table) => {
      if (table !== 'users') return originalFrom(table);
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: null,
              error: { message: 'column users.token_version does not exist' },
            }),
          }),
        }),
      };
    };

    const response = await request(app)
      .post('/api/auth/login')
      .send({ username: 'ana', password: 'parola-veche-lunga' });

    expect(response.status).toBe(500);
    expect(response.body.error).not.toMatch(/invalid credentials/i);
  });

  it('păstrează 401 pentru un utilizator inexistent', async () => {
    const { app } = buildApp(await seedWith());

    const response = await request(app)
      .post('/api/auth/login')
      .send({ username: 'nimeni', password: 'orice-parola-lunga' });

    expect(response.status).toBe(401);
    expect(response.body.error).toMatch(/invalid credentials/i);
  });
});
