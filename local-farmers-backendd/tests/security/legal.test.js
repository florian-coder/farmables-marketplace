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

// LEG-02 — acceptarea la PLASAREA COMENZII, nu doar la înregistrare.
//
// Registrul spunea `requiredAtOrder: true` pe termenii clientului de când
// există termenii; ce lipsea era firul până la checkout. OUG 34/2014 cere
// acceptarea pentru contractul acesta, cu versiunea aflată în vigoare.

const ORDER_SEED = () => ({
  users: [
    { id: '10', username: 'ana', email: 'ana@example.com', user_type: 'client', token_version: 0 },
  ],
  customers: [{ id: '10', name: 'Ana', surname: 'Pop' }],
  farmers: [
    {
      id: '77',
      'farm name': 'Gradina Verde',
      charges_enabled: true,
      stripe_account_id: 'acct_farm',
      delivery_fee_bani: 0,
      min_order_value_bani: 0,
    },
  ],
  orders: [
    { id: 'ord-1', farmer_id: '77', client_id: '10', order_state: 'placed_order', created_at: '2026-08-01' },
  ],
  order_items: [
    {
      id: 'item-1',
      order_id: 'ord-1',
      product_id: 'p-1',
      product_name: 'Rosii',
      quantity: 5,
      unit_price: 20,
      line_total: 100,
    },
  ],
  checkouts: [],
  legal_acceptances: [],
  platform_settings: [{ id: true, commission_bps: 1000, min_charge_bani: 200 }],
});

const startCheckout = async (app, body) => {
  const { sessionCookieFor } = require('../helpers/appHarness');
  const cookie = await sessionCookieFor({ id: '10', role: 'customer', tokenVersion: 0 });
  return request(app)
    .post('/api/checkout/create-checkout-session')
    .set(browserHeaders)
    .set('Cookie', cookie)
    .send(body);
};

describe('LEG-02 — acceptarea la plasarea comenzii', () => {
  it('refuză plata fără acceptare, înainte să rezerve orice stoc', async () => {
    const { app, fake } = buildApp(ORDER_SEED());

    const response = await startCheckout(app, { acceptedDocuments: [] });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('terms_not_accepted');
    // Verificarea e înaintea rezervării: niciun checkout, niciun `process_checkout`.
    expect(fake._db.checkouts).toHaveLength(0);
    expect(fake._calls.rpc.filter((call) => call.name === 'process_checkout')).toHaveLength(0);
  });

  it('refuză o versiune veche cu 409, nu o înregistrează', async () => {
    // Un tab lăsat deschis peste o actualizare a termenilor.
    const { app, fake } = buildApp(ORDER_SEED());

    const response = await startCheckout(app, {
      acceptedDocuments: [{ key: CUSTOMER_DOC.key, version: '0.9' }],
    });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('terms_version_stale');
    expect(fake._db.legal_acceptances).toHaveLength(0);
  });

  it('înregistrează acceptarea cu versiune, context și comandă', async () => {
    const { app, fake } = buildApp(ORDER_SEED());

    await startCheckout(app, {
      acceptedDocuments: [{ key: CUSTOMER_DOC.key, version: CUSTOMER_DOC.version }],
    });

    const acceptance = fake._db.legal_acceptances.find(
      (row) => row.document_key === CUSTOMER_DOC.key && row.context === 'order',
    );
    expect(acceptance).toBeDefined();
    expect(acceptance.document_version).toBe(CUSTOMER_DOC.version);
    expect(acceptance.user_id).toBe('10');
    // Fără comanda la care se referă, dovada nu spune la ce s-a consimțit.
    expect(acceptance.order_id).toBe('ord-1');
  });
});
