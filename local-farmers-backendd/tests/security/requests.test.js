// SEC-04 (CSRF), SEC-05 (proprietarul comenzii), SEC-06 (webhook Stripe).

const request = require('supertest');

const {
  buildApp,
  browserHeaders,
  sessionCookieFor,
} = require('../helpers/appHarness');

const CUSTOMER = { id: '11', role: 'customer', tokenVersion: 0 };
const OTHER_CUSTOMER = { id: '22', role: 'customer', tokenVersion: 0 };

const seed = () => ({
  users: [
    { id: '11', username: 'ana', email: 'ana@example.com', user_type: 'customer', token_version: 0 },
    { id: '22', username: 'radu', email: 'radu@example.com', user_type: 'customer', token_version: 0 },
    { id: '77', username: 'ferma', email: 'ferma@example.com', user_type: 'farmer', token_version: 0 },
  ],
  farmers: [{ id: '77', 'farm name': 'Gradina', IBAN: 'RO49AAAA1B31007593840000' }],
  orders: [
    {
      id: 'aaaaaaaa-0000-0000-0000-000000000001',
      client_id: '11',
      farmer_id: '77',
      order_state: 'placed_order',
      total_price: 120,
      paid_at: null,
    },
  ],
  order_items: [
    {
      id: 'item-1',
      order_id: 'aaaaaaaa-0000-0000-0000-000000000001',
      product_name: 'Rosii',
      product_unit: 'kg',
      quantity: 2,
      unit_price: 60,
      line_total: 120,
    },
  ],
});

const ORDER_ID = 'aaaaaaaa-0000-0000-0000-000000000001';

describe('SEC-04 — cereri de pe alte site-uri', () => {
  it('respinge o cerere cu cookie de sesiune venită de la o origine străină', async () => {
    const { app } = buildApp(seed());
    const cookie = await sessionCookieFor({ id: '77', role: 'vendor', tokenVersion: 0 });

    const response = await request(app)
      .post('/api/vendor/profile')
      .set('Cookie', cookie)
      .set('Origin', 'https://site-atacator.example')
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({ farmName: 'Preluata', iban: 'RO49AAAA1B31007593840000' });

    expect(response.status).toBe(403);
    expect(response.body.error).toMatch(/cross-site/i);
  });

  it('respinge formularul HTML clasic: fără antet propriu nu există preflight', async () => {
    const { app } = buildApp(seed());
    const cookie = await sessionCookieFor({ id: '77', role: 'vendor', tokenVersion: 0 });

    // Exact ce poate trimite un <form> ascuns: multipart, fără antete proprii.
    const response = await request(app)
      .post('/api/vendor/profile')
      .set('Cookie', cookie)
      .set('Origin', 'https://site-atacator.example')
      .field('farmName', 'Preluata')
      .field('iban', 'RO49AAAA1B31007593840000');

    expect(response.status).toBe(403);
  });

  it('respinge cererea de pe origine bună, dar fără antetul propriu', async () => {
    const { app } = buildApp(seed());
    const cookie = await sessionCookieFor({ id: '77', role: 'vendor', tokenVersion: 0 });

    const response = await request(app)
      .post('/api/vendor/profile')
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost:5173')
      .send({ farmName: 'X' });

    expect(response.status).toBe(403);
    expect(response.body.error).toMatch(/X-Requested-With/i);
  });

  it('lasă să treacă cererea frontendului propriu', async () => {
    const { app } = buildApp(seed());
    const cookie = await sessionCookieFor(CUSTOMER);

    const response = await request(app)
      .post('/api/orders/cart/items')
      .set('Cookie', cookie)
      .set(browserHeaders)
      .send({ productId: 'inexistent' });

    // Trece de CSRF și ajunge la logica rutei, care respinge produsul.
    expect(response.status).not.toBe(403);
    expect(response.status).toBe(404);
  });

  it('nu blochează cererile fără cookie de sesiune', async () => {
    const { app } = buildApp(seed());

    const response = await request(app)
      .post('/api/auth/login')
      .send({ username: 'ana', password: 'gresit' });

    // Fără cookie nu există CSRF; răspunde autentificarea, nu middleware-ul.
    expect(response.status).toBe(401);
  });
});

describe('SEC-05 — proprietarul comenzii la checkout', () => {
  it('refuză plata pentru comanda altui client', async () => {
    const { app, fake } = buildApp(seed());
    const cookie = await sessionCookieFor(OTHER_CUSTOMER);

    const response = await request(app)
      .post('/api/checkout/create-checkout-session')
      .set('Cookie', cookie)
      .set(browserHeaders)
      .send({ orderId: ORDER_ID });

    expect(response.status).toBe(404);
    // Esențial: stocul nu a fost atins.
    expect(fake._calls.rpc).toHaveLength(0);
  });

  it('nu scurge existența comenzii: același răspuns ca pentru un id inventat', async () => {
    const { app } = buildApp(seed());
    const cookie = await sessionCookieFor(OTHER_CUSTOMER);

    const real = await request(app)
      .post('/api/checkout/create-checkout-session')
      .set('Cookie', cookie)
      .set(browserHeaders)
      .send({ orderId: ORDER_ID });
    const fabricated = await request(app)
      .post('/api/checkout/create-checkout-session')
      .set('Cookie', cookie)
      .set(browserHeaders)
      .send({ orderId: 'bbbbbbbb-0000-0000-0000-000000000009' });

    expect(real.status).toBe(fabricated.status);
    expect(real.body).toEqual(fabricated.body);
  });

  it('refuză verify-status pentru comanda altcuiva', async () => {
    const { app } = buildApp(seed());
    const cookie = await sessionCookieFor(OTHER_CUSTOMER);

    const response = await request(app)
      .get(`/api/checkout/verify-status/${ORDER_ID}`)
      .set('Cookie', cookie);

    expect(response.status).toBe(404);
  });

  it('nu rezervă stocul de două ori pentru aceeași comandă', async () => {
    const data = seed();
    data.orders[0].order_state = 'pending_order'; // stocul e deja rezervat
    const { app, fake } = buildApp(data);
    const cookie = await sessionCookieFor(CUSTOMER);

    await request(app)
      .post('/api/checkout/create-checkout-session')
      .set('Cookie', cookie)
      .set(browserHeaders)
      .send({ orderId: ORDER_ID });

    const checkoutCalls = fake._calls.rpc.filter((call) => call.name === 'process_checkout');
    expect(checkoutCalls).toHaveLength(0);
  });

  it('refuză plata unei comenzi deja plătite', async () => {
    const data = seed();
    data.orders[0].order_state = 'received_by_farmer';
    data.orders[0].paid_at = new Date().toISOString();
    const { app, fake } = buildApp(data);
    const cookie = await sessionCookieFor(CUSTOMER);

    const response = await request(app)
      .post('/api/checkout/create-checkout-session')
      .set('Cookie', cookie)
      .set(browserHeaders)
      .send({ orderId: ORDER_ID });

    expect(response.status).toBe(400);
    expect(fake._calls.rpc).toHaveLength(0);
  });
});

describe('SEC-06 — webhook Stripe', () => {
  const payload = JSON.stringify({
    id: 'evt_test_1',
    type: 'checkout.session.completed',
    data: { object: { metadata: { orderId: ORDER_ID } } },
  });

  it('refuză evenimentele când secretul de webhook nu e configurat', async () => {
    // Șir gol, nu delete: dotenv repopulează din .env cheile absente la
    // fiecare resetModules, iar '' rămâne al nostru și e falsy pentru rută.
    const previous = process.env.STRIPE_WEBHOOK_SECRET;
    process.env.STRIPE_WEBHOOK_SECRET = '';

    const { app, fake } = buildApp(seed());
    const response = await request(app)
      .post('/api/webhook/stripe')
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(response.status).toBe(500);
    // Comanda a rămas neatinsă: nimeni nu primește marfă pe gratis.
    expect(fake._db.orders[0].order_state).toBe('placed_order');

    process.env.STRIPE_WEBHOOK_SECRET = previous || '';
  });

  it('refuză un eveniment cu semnătură invalidă', async () => {
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret';
    const { app, fake } = buildApp(seed());

    const response = await request(app)
      .post('/api/webhook/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 't=1,v1=semnatura_inventata')
      .send(payload);

    expect(response.status).toBe(400);
    expect(fake._db.orders[0].order_state).toBe('placed_order');
    process.env.STRIPE_WEBHOOK_SECRET = '';
  });
});
