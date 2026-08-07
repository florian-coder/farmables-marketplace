// LEG-03 — GDPR Art. 17 and Art. 20.
//
// The property that matters for erasure is not "the row is gone". It is that
// **nothing identifying survives** while the records the law requires us to
// keep — invoices, food traceability, consent — still exist and still balance.
// A test that only checked for a deleted row would pass on an implementation
// that quietly kept the email address on the order.

const request = require('supertest');

const { buildApp, browserHeaders, sessionCookieFor } = require('../helpers/appHarness');
const { hashPassword } = require('../../src/lib/auth');

const CUSTOMER = { id: '10', role: 'customer', tokenVersion: 0 };
const VENDOR = { id: '77', role: 'vendor', tokenVersion: 0 };
const PASSWORD = 'parola-lunga-si-buna';

const seed = async (overrides = {}) => ({
  users: [
    {
      id: '10',
      username: 'ana',
      email: 'ana@example.com',
      password: await hashPassword(PASSWORD),
      user_type: 'client',
      token_version: 0,
      email_verified: true,
    },
    {
      id: '77',
      username: 'ferma',
      email: 'ferma@example.com',
      password: await hashPassword(PASSWORD),
      user_type: 'farmer',
      token_version: 0,
    },
  ],
  customers: [
    {
      id: '10',
      name: 'Ana',
      surname: 'Pop',
      'address street': 'Strada Lunga',
      'address number': '12',
      'phone number': '0740111222',
      city: 'Cluj',
      county: 'Cluj',
      country: 'Romania',
    },
  ],
  farmers: [
    { id: '77', 'farm name': 'Gradina Verde', email: 'ferma@example.com', charges_enabled: true },
  ],
  orders: [
    {
      id: 'ord-1',
      client_id: '10',
      farmer_id: '77',
      order_state: 'received',
      total_price: 115,
      products_subtotal_bani: 10000,
      delivery_fee_bani: 1500,
      commission_bani: 1000,
      paid_at: '2026-07-01T10:00:00.000Z',
    },
  ],
  order_items: [
    {
      id: 'item-1',
      order_id: 'ord-1',
      product_name: 'Rosii',
      product_unit: 'kg',
      quantity: 5,
      unit_price: 20,
      line_total: 100,
    },
  ],
  conversations: [{ id: 'conv-1', customer_id: '10', vendor_id: '77' }],
  messages: [
    { id: 'msg-1', conversation_id: 'conv-1', sender_user_id: '10', text: 'Is this organic?' },
    { id: 'msg-2', conversation_id: 'conv-1', sender_user_id: '77', text: 'Yes, certified.' },
  ],
  legal_acceptances: [
    {
      id: 'acc-1',
      user_id: '10',
      document_key: 'terms-customers',
      document_version: '1.0',
      context: 'signup',
      accepted_at: '2026-06-01T10:00:00.000Z',
    },
  ],
  products: [],
  farm_photos: [],
  farmer_requests: [],
  farmer_docs: [],
  audit_log: [],
  ...overrides,
});

describe('LEG-03 — Art. 20, data export', () => {
  test('hands over everything we hold, as a downloadable file', async () => {
    const { app } = buildApp(await seed());

    const response = await request(app)
      .get('/api/profile/export')
      .set('Cookie', await sessionCookieFor(CUSTOMER));

    expect(response.status).toBe(200);
    expect(response.headers['content-disposition']).toMatch(/attachment/);

    const data = JSON.parse(response.text);
    expect(data.account.email).toBe('ana@example.com');
    expect(data.customerProfile.name).toBe('Ana');
    expect(data.orders).toHaveLength(1);
    expect(data.orderItems).toHaveLength(1);
    expect(data.consentRecords).toHaveLength(1);
  });

  test('does not hand over the other side of a conversation', async () => {
    // The farm's messages are the farm's personal data. Including them would
    // be a disclosure dressed up as a portability response.
    const { app } = buildApp(await seed());

    const response = await request(app)
      .get('/api/profile/export')
      .set('Cookie', await sessionCookieFor(CUSTOMER));

    const data = JSON.parse(response.text);
    const texts = data.messagesYouSent.map((message) => message.text);
    expect(texts).toContain('Is this organic?');
    expect(texts).not.toContain('Yes, certified.');
  });

  test('is recorded in the audit log', async () => {
    const { app, fake } = buildApp(await seed());

    await request(app).get('/api/profile/export').set('Cookie', await sessionCookieFor(CUSTOMER));

    expect(fake._db.audit_log.map((row) => row.action)).toContain('data.exported');
  });

  test('needs a session', async () => {
    const { app } = buildApp(await seed());
    const response = await request(app).get('/api/profile/export');
    expect(response.status).toBe(401);
  });
});

describe('LEG-03 — Art. 17, erasure', () => {
  const deleteAccount = async (app, cookie, body = {}) =>
    request(app)
      .post('/api/profile/delete')
      .set(browserHeaders)
      .set('Cookie', cookie)
      .send({ password: PASSWORD, ...body });

  test('destroys every identifier and keeps the accounting record', async () => {
    const { app, fake } = buildApp(await seed());

    const response = await deleteAccount(app, await sessionCookieFor(CUSTOMER));
    expect(response.status).toBe(200);
    expect(response.body.deleted).toBe(true);

    // Nothing identifying survives on the account.
    const user = fake._db.users.find((row) => row.id === '10');
    expect(user.email).toBe('');
    expect(user.username).toMatch(/^deleted-/);
    expect(user.deleted_at).toBeTruthy();

    // The customer profile is pure personal data — it goes entirely.
    expect(fake._db.customers.find((row) => row.id === '10')).toBeUndefined();

    // The order survives, because accounting law says ten years, and it still
    // adds up: it now points at a pseudonym that leads nowhere.
    const order = fake._db.orders.find((row) => row.id === 'ord-1');
    expect(order).toBeDefined();
    expect(order.products_subtotal_bani).toBe(10000);
    expect(fake._db.order_items).toHaveLength(1);
  });

  test('keeps the consent record — the one thing deletion must not touch', async () => {
    // Proof of consent is worthless if the person disputing it can erase it.
    const { app, fake } = buildApp(await seed());

    await deleteAccount(app, await sessionCookieFor(CUSTOMER));

    expect(fake._db.legal_acceptances).toHaveLength(1);
    expect(fake._db.legal_acceptances[0].document_version).toBe('1.0');
  });

  test('drops the message text but keeps the fact of the conversation', async () => {
    const { app, fake } = buildApp(await seed());

    await deleteAccount(app, await sessionCookieFor(CUSTOMER));

    const ownMessage = fake._db.messages.find((row) => row.id === 'msg-1');
    const otherMessage = fake._db.messages.find((row) => row.id === 'msg-2');
    expect(ownMessage.text).toBe('[deleted by the author]');
    // The farm's own message is not this user's to erase.
    expect(otherMessage.text).toBe('Yes, certified.');
    expect(fake._db.conversations).toHaveLength(1);
  });

  test('revokes every session, everywhere, before anything else', async () => {
    const { app, fake } = buildApp(await seed());

    await deleteAccount(app, await sessionCookieFor(CUSTOMER));

    // SEC-08: bumping token_version invalidates issued tokens instantly. Even
    // a deletion that then failed part-way leaves the account unusable.
    expect(Number(fake._db.users.find((row) => row.id === '10').token_version)).toBe(1);
  });

  test('refuses without the password', async () => {
    const { app, fake } = buildApp(await seed());

    const noPassword = await request(app)
      .post('/api/profile/delete')
      .set(browserHeaders)
      .set('Cookie', await sessionCookieFor(CUSTOMER))
      .send({});
    expect(noPassword.status).toBe(400);

    const wrongPassword = await deleteAccount(app, await sessionCookieFor(CUSTOMER), {
      password: 'not-the-password',
    });
    expect(wrongPassword.status).toBe(401);

    // Nothing happened either time.
    expect(fake._db.users.find((row) => row.id === '10').email).toBe('ana@example.com');
  });

  test('refuses while an order is still running', async () => {
    const data = await seed();
    data.orders[0].order_state = 'in_transit';
    const { app, fake } = buildApp(data);

    const response = await deleteAccount(app, await sessionCookieFor(CUSTOMER));

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('orders_in_progress');
    expect(fake._db.users.find((row) => row.id === '10').email).toBe('ana@example.com');
  });

  test('a farm that has sold is closed, not removed — traceability points at it', async () => {
    const { app, fake } = buildApp(await seed());

    const response = await deleteAccount(app, await sessionCookieFor(VENDOR));
    expect(response.status).toBe(200);

    const farm = fake._db.farmers.find((row) => row.id === '77');
    expect(farm).toBeDefined();
    expect(farm['farm name']).toMatch(/^Closed farm/);
    expect(farm.email).toBe('');
    // And it can never sell again.
    expect(farm.charges_enabled).toBe(false);
  });

  test('a farm that never sold is removed outright', async () => {
    const data = await seed();
    data.orders = [];
    data.order_items = [];
    data.products = [{ id: 'p-1', farmer_id: '77', 'product name': 'Rosii' }];
    data.farmer_requests = [{ id: 'req-1', user_id: '77', documents: { cui: 'x' } }];
    const { app, fake } = buildApp(data);

    await deleteAccount(app, await sessionCookieFor(VENDOR));

    expect(fake._db.farmers.find((row) => row.id === '77')).toBeUndefined();
    expect(fake._db.products).toHaveLength(0);
    // The uploaded documents are the most sensitive thing we hold about a
    // producer, and nothing requires keeping them once the farm is gone.
    expect(fake._db.farmer_requests).toHaveLength(0);
  });

  test('records that a deletion happened, without naming who', async () => {
    const { app, fake } = buildApp(await seed());

    await deleteAccount(app, await sessionCookieFor(CUSTOMER));

    const entry = fake._db.audit_log.find((row) => row.action === 'account.deleted');
    expect(entry).toBeDefined();
    // The audit entry must not re-identify the person it says was erased.
    expect(entry.actor_id).toMatch(/^deleted-/);
    expect(entry.actor_id).not.toBe('10');
  });
});

describe('LEG-03 — telling people what deletion does', () => {
  test('publishes the plan before the confirmation', async () => {
    const { app } = buildApp(await seed());

    const response = await request(app)
      .get('/api/profile/deletion-plan')
      .set('Cookie', await sessionCookieFor(CUSTOMER));

    expect(response.status).toBe(200);
    // The gap between what someone expects "delete everything" to mean and
    // what the law allows is exactly where trust is lost.
    expect(response.body.plan.erased.length).toBeGreaterThan(0);
    expect(response.body.plan.kept.join(' ')).toMatch(/accounting/i);
    expect(response.body.plan.kept.join(' ')).toMatch(/traceability/i);
  });
});
