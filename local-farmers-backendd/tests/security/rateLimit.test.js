// SEC-07 — limitarea de rată, testată cu limitatoarele ACTIVE.
// Restul suitei rulează cu DISABLE_RATE_LIMIT=1, altfel fiecare fișier de test
// ar lovi plafonul de pe aceeași adresă.

const request = require('supertest');

const { buildApp } = require('../helpers/appHarness');

const seed = () => ({
  users: [
    { id: '11', username: 'ana', email: 'ana@example.com', user_type: 'customer', password: 'x', token_version: 0 },
  ],
});

describe('SEC-07 — limitare de rată pe autentificare', () => {
  let previous;

  beforeAll(() => {
    previous = process.env.DISABLE_RATE_LIMIT;
    process.env.DISABLE_RATE_LIMIT = '0';
  });

  afterAll(() => {
    process.env.DISABLE_RATE_LIMIT = previous ?? '1';
  });

  it('blochează atacul prin dicționar după un număr mic de încercări', async () => {
    const { app } = buildApp(seed());
    const statuses = [];

    for (let attempt = 0; attempt < 14; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      const response = await request(app)
        .post('/api/auth/login')
        .send({ username: 'ana', password: `incercarea-${attempt}` });
      statuses.push(response.status);
    }

    // Primele încercări primesc 401, apoi limitatorul intervine cu 429.
    expect(statuses[0]).toBe(401);
    expect(statuses).toContain(429);
    // Plafonul e strâns: cel mult 10 încercări trec de limitatorul pe IP.
    expect(statuses.filter((status) => status === 401).length).toBeLessThanOrEqual(10);
  });

  it('limitează și cererile de resetare a parolei', async () => {
    const { app } = buildApp(seed());
    const statuses = [];

    for (let attempt = 0; attempt < 14; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      const response = await request(app)
        .post('/api/auth/forgot-password')
        .send({ email: `victima${attempt}@example.com` });
      statuses.push(response.status);
    }

    expect(statuses).toContain(429);
  });

  it('nu limitează navigarea normală', async () => {
    const { app } = buildApp(seed());

    const responses = await Promise.all(
      Array.from({ length: 20 }, () => request(app).get('/api/health')),
    );

    expect(responses.every((response) => response.status === 200)).toBe(true);
  });
});
