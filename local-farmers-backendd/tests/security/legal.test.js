// LEG-02 / LEG-03 — acceptarea termenilor la înregistrare.
//
// Ce se verifică: un cont nu poate exista fără dovadă de acceptare, dovada
// poartă versiunea exactă, iar o versiune veche e refuzată în loc să fie
// înregistrată.

const request = require('supertest');

const { buildApp, browserHeaders } = require('../helpers/appHarness');
const { LEGAL_DOCUMENTS } = require('../../src/lib/legalDocuments');

const CUSTOMER_DOC = LEGAL_DOCUMENTS['terms-customers'];
const PRODUCER_DOC = LEGAL_DOCUMENTS['terms-producers'];

const seed = () => ({
  users: [],
  customers: [],
  legal_acceptances: [],
});

const signupBody = (overrides = {}) => ({
  username: 'ana',
  email: 'ana@example.com',
  password: 'parola-lunga-si-buna',
  role: 'customer',
  acceptedDocuments: [{ key: CUSTOMER_DOC.key, version: CUSTOMER_DOC.version }],
  ...overrides,
});

const signup = (app, body) =>
  request(app).post('/api/auth/signup').set(browserHeaders).send(body);

describe('LEG-02 — registrul de documente', () => {
  it('publică versiunile în vigoare, fără autentificare', async () => {
    const { app } = buildApp(seed());
    const response = await request(app).get('/api/legal/documents');

    expect(response.status).toBe(200);
    const customerEntry = response.body.documents.find((doc) => doc.key === 'terms-customers');
    expect(customerEntry).toMatchObject({
      version: CUSTOMER_DOC.version,
      audience: 'customer',
      requiredAtSignup: true,
    });
  });
});

describe('LEG-03 — acceptarea la înregistrare', () => {
  it('refuză contul fără acceptare', async () => {
    const { app, fake } = buildApp(seed());

    const response = await signup(app, signupBody({ acceptedDocuments: [] }));

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('terms_not_accepted');
    // Esențial: contul nu s-a creat deloc.
    expect(fake._db.users).toHaveLength(0);
  });

  it('refuză contul dacă lipsește complet câmpul', async () => {
    const { app, fake } = buildApp(seed());
    const body = signupBody();
    delete body.acceptedDocuments;

    const response = await signup(app, body);

    expect(response.status).toBe(400);
    expect(fake._db.users).toHaveLength(0);
  });

  it('refuză o versiune veche cu 409, în loc să o înregistreze', async () => {
    const { app, fake } = buildApp(seed());

    const response = await signup(
      app,
      signupBody({ acceptedDocuments: [{ key: CUSTOMER_DOC.key, version: '0.9' }] }),
    );

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('terms_version_stale');
    expect(fake._db.users).toHaveLength(0);
    expect(fake._db.legal_acceptances).toHaveLength(0);
  });

  it('refuză acceptarea documentului greșit pentru rol', async () => {
    const { app, fake } = buildApp(seed());

    // Un client care bifează termenii de producător nu a acceptat nimic valid.
    const response = await signup(
      app,
      signupBody({
        acceptedDocuments: [{ key: PRODUCER_DOC.key, version: PRODUCER_DOC.version }],
      }),
    );

    expect(response.status).toBe(400);
    expect(fake._db.users).toHaveLength(0);
  });

  it('creează contul și scrie dovada, cu versiune, context și IP', async () => {
    const { app, fake } = buildApp(seed());

    const response = await signup(app, signupBody());

    expect(response.status).toBe(201);
    expect(fake._db.users).toHaveLength(1);

    expect(fake._db.legal_acceptances).toHaveLength(1);
    const record = fake._db.legal_acceptances[0];
    expect(record).toMatchObject({
      document_key: CUSTOMER_DOC.key,
      document_version: CUSTOMER_DOC.version,
      context: 'signup',
    });
    expect(String(record.user_id)).toBe(String(fake._db.users[0].id));
    expect(record.ip).toBeTruthy();
    // `accepted_at` vine din DEFAULT-ul coloanei, deci nu apare în payload și
    // nu poate fi verificat aici — Supabase-ul fals nu aplică default-uri.
  });

  it('cere producătorului documentul B2B, nu pe cel de client', async () => {
    const { app, fake } = buildApp(seed());

    const response = await signup(
      app,
      signupBody({
        username: 'ferma',
        email: 'ferma@example.com',
        role: 'vendor',
        acceptedDocuments: [{ key: PRODUCER_DOC.key, version: PRODUCER_DOC.version }],
      }),
    );

    expect(response.status).toBe(201);
    expect(fake._db.legal_acceptances[0].document_key).toBe(PRODUCER_DOC.key);
  });
});
