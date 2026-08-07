// SEC-09b — an address we can actually reach.
//
// The finding: `email_verified` was written but never enforced, and accounts
// created before email was collected carry `<username>@localfarmers.app` —
// a domain that accepts no mail — with no state that says so.
//
// The line this draws: verification gates **paying**, not **signing in**.
// Locking someone out of an account they can prove they own by knowing the
// password is punishment, not security. But an order produces a confirmation
// that GEO 34/2014 art. 8 requires to reach a durable medium, so an order we
// cannot confirm is an order we should not take.

const request = require('supertest');

const { buildApp, browserHeaders, sessionCookieFor } = require('../helpers/appHarness');
const { hashPassword } = require('../../src/lib/auth');
const { emailStatus, isGeneratedEmail, checkoutBlockerFor } = require('../../src/lib/emailStatus');
const { LEGAL_DOCUMENTS } = require('../../src/lib/legalDocuments');

const CUSTOMER = { id: '10', role: 'customer', tokenVersion: 0 };
const PASSWORD = 'parola-lunga-si-buna';

const CONSENT = {
  acceptedDocuments: [
    {
      key: LEGAL_DOCUMENTS['terms-customers'].key,
      version: LEGAL_DOCUMENTS['terms-customers'].version,
    },
  ],
};

describe('SEC-09b — classifying an address', () => {
  test('recognises the addresses the old signup flow invented', () => {
    expect(isGeneratedEmail('ana@localfarmers.app')).toBe(true);
    expect(isGeneratedEmail('ANA@LocalFarmers.App')).toBe(true);
    expect(isGeneratedEmail('ana@gmail.com')).toBe(false);
  });

  test('treats a generated address as absent, not as unverified', () => {
    // The difference decides the remedy: an absent address needs replacing,
    // an unverified one needs a reminder.
    expect(emailStatus({ email: 'ana@localfarmers.app', email_verified: false })).toBe('missing');
    // Even if something flipped the flag: the domain still accepts no mail.
    expect(emailStatus({ email: 'ana@localfarmers.app', email_verified: true })).toBe('missing');
    expect(emailStatus({ email: '', email_verified: true })).toBe('missing');
    expect(emailStatus({ email: 'not-an-address', email_verified: true })).toBe('missing');
  });

  test('separates a real unverified address from a verified one', () => {
    expect(emailStatus({ email: 'ana@gmail.com', email_verified: false })).toBe('unverified');
    expect(emailStatus({ email: 'ana@gmail.com', email_verified: true })).toBe('verified');
  });

  test('blocks checkout only for an address that does not exist', () => {
    expect(checkoutBlockerFor({ email: 'ana@localfarmers.app' })?.code).toBe('email_missing');
    expect(checkoutBlockerFor({ email: '' })?.code).toBe('email_missing');
    // An unverified real address still has somewhere for the confirmation to
    // go. Blocking a first purchase on an unclicked link loses far more than
    // it protects.
    expect(checkoutBlockerFor({ email: 'ana@gmail.com', email_verified: false })).toBeNull();
    expect(checkoutBlockerFor({ email: 'ana@gmail.com', email_verified: true })).toBeNull();
  });
});

const seed = async (email = 'ana@localfarmers.app') => ({
  users: [
    {
      id: '10',
      username: 'ana',
      email,
      password: await hashPassword(PASSWORD),
      user_type: 'client',
      token_version: 0,
      email_verified: false,
    },
    { id: '99', username: 'radu', email: 'radu@example.com', user_type: 'client', token_version: 0 },
  ],
  customers: [{ id: '10', name: 'Ana', surname: 'Pop' }],
  farmers: [
    {
      id: '77',
      'farm name': 'Gradina',
      charges_enabled: true,
      stripe_account_id: 'acct_x',
      delivery_fee_bani: 0,
      min_order_value_bani: 0,
    },
  ],
  orders: [
    { id: 'ord-1', farmer_id: '77', client_id: '10', order_state: 'placed_order', created_at: '2026-08-01' },
  ],
  order_items: [
    { id: 'i-1', order_id: 'ord-1', product_name: 'Rosii', quantity: 5, unit_price: 20, line_total: 100 },
  ],
  platform_settings: [{ id: true, commission_bps: 1000, min_charge_bani: 200 }],
  checkouts: [],
  auth_tokens: [],
  email_outbox: [],
  audit_log: [],
  legal_acceptances: [],
});

describe('SEC-09b — the gate is at checkout, not at the door', () => {
  test('a legacy account can still sign in and browse', async () => {
    const { app } = buildApp(await seed());

    const response = await request(app)
      .get('/api/auth/me')
      .set('Cookie', await sessionCookieFor(CUSTOMER));

    expect(response.status).toBe(200);
    // ...and is told where it stands, well before it reaches a checkout.
    expect(response.body.emailStatus).toBe('missing');
  });

  test('but cannot pay, and is told exactly why', async () => {
    const { app, fake } = buildApp(await seed());

    const response = await request(app)
      .post('/api/checkout/create-checkout-session')
      .set(browserHeaders)
      .set('Cookie', await sessionCookieFor(CUSTOMER))
      .send(CONSENT);

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('email_missing');
    // Checked before anything is reserved: a refusal costs no stock.
    expect(fake._db.checkouts).toHaveLength(0);
    expect(fake._calls.rpc).toHaveLength(0);
  });

  test('an unverified but real address can pay', async () => {
    const { app } = buildApp(await seed('ana@gmail.com'));

    const response = await request(app)
      .post('/api/checkout/create-checkout-session')
      .set(browserHeaders)
      .set('Cookie', await sessionCookieFor(CUSTOMER))
      .send(CONSENT);

    // Whatever else happens, it is not the email gate that stopped it.
    expect(response.body.code).not.toBe('email_missing');
  });
});

describe('SEC-09b — supplying a real address', () => {
  const setEmail = async (app, body) =>
    request(app)
      .post('/api/auth/email')
      .set(browserHeaders)
      .set('Cookie', await sessionCookieFor(CUSTOMER))
      .send({ password: PASSWORD, ...body });

  test('saves it unverified and queues the verification link', async () => {
    const { app, fake } = buildApp(await seed());

    const response = await setEmail(app, { email: 'ana@gmail.com' });

    expect(response.status).toBe(200);
    expect(response.body.emailStatus).toBe('unverified');

    const user = fake._db.users.find((row) => row.id === '10');
    expect(user.email).toBe('ana@gmail.com');
    expect(user.email_verified).toBe(false);

    const queued = fake._db.email_outbox.find((row) => row.template === 'auth.verify_email');
    expect(queued.recipient).toBe('ana@gmail.com');
  });

  test('requires the password — email is the reset channel', async () => {
    // Without this, a session left open on a shared laptop is a full account
    // takeover: change the address, then use "forgot password".
    const { app, fake } = buildApp(await seed());

    const noPassword = await request(app)
      .post('/api/auth/email')
      .set(browserHeaders)
      .set('Cookie', await sessionCookieFor(CUSTOMER))
      .send({ email: 'attacker@example.com' });
    expect(noPassword.status).toBe(400);

    const wrongPassword = await setEmail(app, {
      email: 'attacker@example.com',
      password: 'wrong',
    });
    expect(wrongPassword.status).toBe(401);

    expect(fake._db.users.find((row) => row.id === '10').email).toBe('ana@localfarmers.app');
  });

  test('refuses another platform-generated address', async () => {
    const { app } = buildApp(await seed());
    const response = await setEmail(app, { email: 'someone@localfarmers.app' });
    expect(response.status).toBe(400);
  });

  test('refuses an address already on another account', async () => {
    // Claiming it would redirect that person's password reset.
    const { app, fake } = buildApp(await seed());

    const response = await setEmail(app, { email: 'radu@example.com' });

    expect(response.status).toBe(409);
    expect(fake._db.users.find((row) => row.id === '10').email).toBe('ana@localfarmers.app');
  });

  test('changing a verified address makes it unverified again', async () => {
    // Otherwise a change would launder an unverified address into a verified
    // one, which is the whole thing the flag is supposed to mean.
    const data = await seed('ana@gmail.com');
    data.users[0].email_verified = true;
    const { app, fake } = buildApp(data);

    await setEmail(app, { email: 'ana@yahoo.com' });

    const user = fake._db.users.find((row) => row.id === '10');
    expect(user.email).toBe('ana@yahoo.com');
    expect(user.email_verified).toBe(false);
  });

  test('records the change with the addresses masked', async () => {
    const { app, fake } = buildApp(await seed());

    await setEmail(app, { email: 'ana@gmail.com' });

    const entry = fake._db.audit_log.find((row) => row.action === 'email.changed');
    expect(entry).toBeDefined();
    // A leaked audit log must not become a mailing list.
    expect(entry.new_value).toBe('a***@gmail.com');
    expect(entry.new_value).not.toContain('ana@');
  });
});

describe('SEC-09b — resending the link', () => {
  test('sends again for a real unverified address', async () => {
    const { app, fake } = buildApp(await seed('ana@gmail.com'));

    const response = await request(app)
      .post('/api/auth/resend-verification')
      .set(browserHeaders)
      .set('Cookie', await sessionCookieFor(CUSTOMER))
      .send({});

    expect(response.status).toBe(200);
    expect(fake._db.email_outbox.some((row) => row.template === 'auth.verify_email')).toBe(true);
  });

  test('refuses when there is no address to send to', async () => {
    const { app } = buildApp(await seed());

    const response = await request(app)
      .post('/api/auth/resend-verification')
      .set(browserHeaders)
      .set('Cookie', await sessionCookieFor(CUSTOMER))
      .send({});

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('email_missing');
  });
});

describe('LEG-03 — a deleted account cannot come back on an old session', () => {
  test('a signed, unexpired token for an anonymised account is refused', async () => {
    const data = await seed('ana@gmail.com');
    data.users[0].deleted_at = '2026-08-01T00:00:00.000Z';
    const { app } = buildApp(data);

    const response = await request(app)
      .get('/api/auth/me')
      .set('Cookie', await sessionCookieFor(CUSTOMER));

    expect(response.status).toBe(401);
  });
});
