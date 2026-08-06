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
  farmers: [
    {
      id: '77',
      'farm name': 'Gradina',
      // Poate primi bani: fără asta, coșul nici nu se poate finaliza.
      stripe_account_id: 'acct_test_77',
      charges_enabled: true,
      delivery_fee_bani: 0,
      min_order_value_bani: 0,
      free_delivery_threshold_bani: null,
    },
  ],
  platform_settings: [{ id: true, commission_bps: 1000, min_charge_bani: 200 }],
  checkouts: [],
  order_transfers: [],
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

// SEC-05 — checkout-ul nu mai primește niciun identificator de comandă.
//
// Ruta veche accepta un `orderId` din corpul cererii, ceea ce a fost exact
// gaura prin care un client putea declanșa `process_checkout` pe comanda
// altuia și să îi golească stocul. Acum coșul e definit strict ca „rândurile
// `placed_order` ale celui autentificat", deci nu mai există parametru de
// falsificat. Testele verifică proprietatea, nu vechea apărare.
describe('SEC-05 — coșul e al celui autentificat, fără identificator în cerere', () => {
  it('nu atinge coșul altui client, nici cu id-ul lui în corp', async () => {
    const { app, fake } = buildApp(seed());
    const cookie = await sessionCookieFor(OTHER_CUSTOMER);

    const response = await request(app)
      .post('/api/checkout/create-checkout-session')
      .set('Cookie', cookie)
      .set(browserHeaders)
      .send({ orderId: ORDER_ID });

    // Coșul lui radu e gol; comanda anei nu intră în el.
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/coșul este gol/i);
    // Esențial: stocul nu a fost atins.
    expect(fake._calls.rpc).toHaveLength(0);
    expect(fake._db.orders[0].order_state).toBe('placed_order');
  });

  it('ignoră complet un orderId trimis de un client vechi', async () => {
    const { app } = buildApp(seed());
    const cookie = await sessionCookieFor(OTHER_CUSTOMER);

    const withId = await request(app)
      .post('/api/checkout/create-checkout-session')
      .set('Cookie', cookie)
      .set(browserHeaders)
      .send({ orderId: ORDER_ID });
    const withoutId = await request(app)
      .post('/api/checkout/create-checkout-session')
      .set('Cookie', cookie)
      .set(browserHeaders)
      .send({});

    expect(withId.status).toBe(withoutId.status);
    expect(withId.body).toEqual(withoutId.body);
  });

  it('refuză starea plății pentru checkout-ul altcuiva, la fel ca pentru unul inventat', async () => {
    const data = seed();
    data.checkouts = [
      {
        id: 'cccccccc-0000-0000-0000-000000000001',
        client_id: '11',
        state: 'awaiting_payment',
        transfer_group: 'chk_test',
        total_bani: 12000,
      },
    ];
    const { app } = buildApp(data);
    const cookie = await sessionCookieFor(OTHER_CUSTOMER);

    const real = await request(app)
      .get('/api/checkout/cccccccc-0000-0000-0000-000000000001/status')
      .set('Cookie', cookie);
    const fabricated = await request(app)
      .get('/api/checkout/cccccccc-0000-0000-0000-000000000099/status')
      .set('Cookie', cookie);

    expect(real.status).toBe(404);
    expect(real.body).toEqual(fabricated.body);
  });

  it('nu rezervă stocul pentru o comandă care a trecut deja de coș', async () => {
    const data = seed();
    data.orders[0].order_state = 'pending_order'; // stocul e deja rezervat
    const { app, fake } = buildApp(data);
    const cookie = await sessionCookieFor(CUSTOMER);

    const response = await request(app)
      .post('/api/checkout/create-checkout-session')
      .set('Cookie', cookie)
      .set(browserHeaders)
      .send({});

    expect(response.status).toBe(400);
    const checkoutCalls = fake._calls.rpc.filter((call) => call.name === 'process_checkout');
    expect(checkoutCalls).toHaveLength(0);
  });

  it('nu rezervă stocul pentru o comandă deja plătită', async () => {
    const data = seed();
    data.orders[0].order_state = 'received_by_farmer';
    data.orders[0].paid_at = new Date().toISOString();
    const { app, fake } = buildApp(data);
    const cookie = await sessionCookieFor(CUSTOMER);

    const response = await request(app)
      .post('/api/checkout/create-checkout-session')
      .set('Cookie', cookie)
      .set(browserHeaders)
      .send({});

    expect(response.status).toBe(400);
    expect(fake._calls.rpc).toHaveLength(0);
  });
});

// LEG-01 / BIZ-01 — ce vede clientul înainte să plătească.
describe('Checkout — defalcarea costurilor și pragurile fermierului', () => {
  it('arată subtotal, comision și total, fără costuri surpriză', async () => {
    const { app } = buildApp(seed());
    const cookie = await sessionCookieFor(CUSTOMER);

    const response = await request(app).get('/api/checkout/summary').set('Cookie', cookie);

    expect(response.status).toBe(200);
    expect(response.body.commissionBps).toBe(1000);
    expect(response.body.totals).toMatchObject({
      productsSubtotalBani: 12000,
      deliveryFeeBani: 0,
      commissionBani: 1200,
      customerTotalBani: 13200,
    });
    expect(response.body.payable).toBe(true);
  });

  it('adaugă taxa de livrare o singură dată per fermier', async () => {
    const data = seed();
    data.farmers[0].delivery_fee_bani = 1500;
    data.order_items.push({
      id: 'item-2',
      order_id: ORDER_ID,
      product_name: 'Castraveti',
      product_unit: 'kg',
      quantity: 1,
      unit_price: 10,
      line_total: 10,
    });
    const { app } = buildApp(data);
    const cookie = await sessionCookieFor(CUSTOMER);

    const response = await request(app).get('/api/checkout/summary').set('Cookie', cookie);

    // Două produse, o singură taxă de livrare.
    expect(response.body.totals.deliveryFeeBani).toBe(1500);
    expect(response.body.totals.productsSubtotalBani).toBe(13000);
    // Comisionul se aplică doar produselor, nu și livrării.
    expect(response.body.totals.commissionBani).toBe(1300);
    expect(response.body.totals.customerTotalBani).toBe(13000 + 1500 + 1300);
  });

  it('blochează coșul sub comanda minimă a fermierului și spune cât lipsește', async () => {
    const data = seed();
    data.farmers[0].min_order_value_bani = 20000;
    const { app, fake } = buildApp(data);
    const cookie = await sessionCookieFor(CUSTOMER);

    const summary = await request(app).get('/api/checkout/summary').set('Cookie', cookie);
    expect(summary.body.payable).toBe(false);
    expect(summary.body.blockers[0].message).toMatch(/mai adaugă 80,00 lei/i);
    expect(summary.body.blockers[0].message).toMatch(/200,00 lei/);

    const attempt = await request(app)
      .post('/api/checkout/create-checkout-session')
      .set('Cookie', cookie)
      .set(browserHeaders)
      .send({});

    expect(attempt.status).toBe(409);
    expect(fake._calls.rpc).toHaveLength(0);
  });

  it('refuză coșul unui fermier care nu poate încă primi plăți', async () => {
    const data = seed();
    data.farmers[0].charges_enabled = false;
    const { app, fake } = buildApp(data);
    const cookie = await sessionCookieFor(CUSTOMER);

    const response = await request(app)
      .post('/api/checkout/create-checkout-session')
      .set('Cookie', cookie)
      .set(browserHeaders)
      .send({});

    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/nu poate încă primi plăți/i);
    expect(fake._calls.rpc).toHaveLength(0);
  });

  it('scutește livrarea peste pragul de livrare gratuită', async () => {
    const data = seed();
    data.farmers[0].delivery_fee_bani = 1500;
    data.farmers[0].free_delivery_threshold_bani = 10000;
    const { app } = buildApp(data);
    const cookie = await sessionCookieFor(CUSTOMER);

    const response = await request(app).get('/api/checkout/summary').set('Cookie', cookie);

    expect(response.body.totals.deliveryFeeBani).toBe(0);
    expect(response.body.groups[0].deliveryFeeWaived).toBe(true);
  });
});

describe('SEC-06 — webhook Stripe', () => {
  const payload = JSON.stringify({
    id: 'evt_test_1',
    type: 'checkout.session.completed',
    data: { object: { metadata: { orderId: ORDER_ID } } },
  });

  it('procesul nu pornește deloc fără secretul de webhook', async () => {
    // Verificarea s-a mutat din rută în configurare: fără secret nu se poate
    // valida semnătura, deci nu se poate ști dacă un eveniment vine de la
    // Stripe. Un proces care pornește oricum arată sănătos în timp ce acceptă
    // confirmări de plată false — mai rău decât un proces care refuză.
    const previous = process.env.STRIPE_WEBHOOK_SECRET;
    process.env.STRIPE_WEBHOOK_SECRET = '';

    jest.resetModules();
    expect(() => require('../../src/lib/config')).toThrow(/STRIPE_WEBHOOK_SECRET/);

    process.env.STRIPE_WEBHOOK_SECRET = previous || 'whsec_test_secret';
    jest.resetModules();
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
