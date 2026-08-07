// LEG-07 (DSA art. 30) and OPS-05 — who the seller is, and how to reach them.
//
// Two findings pulling opposite ways, resolved by noticing they are about
// different information:
//
//   identification (legal name, registration number, registered office)
//     — public, always. DSA art. 30 requires it, customer terms §7.2 promises
//       it, and it is a matter of public record anyway.
//   direct contact (phone, personal email)
//     — after a paid order. Before that it is a scraped contact list waiting
//       to happen, and the route by which a customer pays cash and loses every
//       protection they were about to have.

const request = require('supertest');

const { buildApp, sessionCookieFor } = require('../helpers/appHarness');
const { publicTraderDetails, applyContactVisibility } = require('../../src/lib/traderDetails');

const CUSTOMER = { id: '10', role: 'customer', tokenVersion: 0 };
const OTHER_CUSTOMER = { id: '11', role: 'customer', tokenVersion: 0 };

const seed = (overrides = {}) => ({
  users: [
    { id: '10', username: 'ana', email: 'ana@example.com', user_type: 'client', token_version: 0 },
    { id: '11', username: 'radu', email: 'radu@example.com', user_type: 'client', token_version: 0 },
    { id: '77', username: 'ferma', email: 'ferma@example.com', user_type: 'farmer', token_version: 0 },
  ],
  farmers: [
    {
      id: '77',
      'farm name': 'Gradina Verde',
      'display name': 'Gradina',
      'street address': 'Strada Lunga',
      'street number': '12',
      city: 'Cluj-Napoca',
      county: 'Cluj',
      'phone number': '0740111222',
      email: 'ferma@example.com',
      charges_enabled: true,
      legal_name: 'POPESCU ION PFA',
      trade_register_number: 'F12/345/2020',
      cui: 'RO12345678',
      trader_type: 'pfa',
    },
  ],
  products: [],
  farm_photos: [],
  orders: [],
  ...overrides,
});

const paidOrder = {
  id: 'ord-1',
  client_id: '10',
  farmer_id: '77',
  order_state: 'received',
  paid_at: '2026-07-01T10:00:00.000Z',
};

describe('LEG-07 — identification is public, always', () => {
  test('shows the legal name, registration number and registered office', async () => {
    // DSA art. 30, and customer terms §7.2 already promises it.
    const { app } = buildApp(seed());

    const response = await request(app).get('/api/vendors/77');

    expect(response.status).toBe(200);
    expect(response.body.vendor.trader).toMatchObject({
      legalName: 'POPESCU ION PFA',
      registrationNumber: 'F12/345/2020',
      vatNumber: 'RO12345678',
      traderType: 'pfa',
    });
    expect(response.body.vendor.trader.registeredOffice).toContain('Cluj-Napoca');
  });

  test('is shown to a signed-out visitor too — that is the point', async () => {
    const { app } = buildApp(seed());
    const response = await request(app).get('/api/vendors/77');
    expect(response.body.vendor.trader.legalName).toBe('POPESCU ION PFA');
  });

  test('marks an incomplete trader block rather than hiding the gap', () => {
    // A farm that has not supplied its registration number should look
    // incomplete, not look like it has nothing to declare.
    expect(publicTraderDetails({ 'farm name': 'X', city: 'Cluj', cui: 'RO1' }).isComplete).toBe(true);
    expect(publicTraderDetails({ 'farm name': 'X', city: 'Cluj' }).isComplete).toBe(false);
    expect(publicTraderDetails({}).isComplete).toBe(false);
  });

  test('defaults the trader type to unknown rather than guessing it', () => {
    // An incorrect trader type makes a claim about which consumer rights
    // apply. Visibly missing is better than confidently wrong.
    expect(publicTraderDetails({ 'farm name': 'X' }).traderType).toBe('unknown');
  });
});

describe('OPS-05 — direct contact is not public', () => {
  test('hides phone and email from a signed-out visitor', async () => {
    const { app } = buildApp(seed());

    const response = await request(app).get('/api/vendors/77');

    expect(response.body.vendor.phoneNumber).toBe('');
    expect(response.body.vendor.email).toBe('');
    expect(response.body.vendor.contactVisible).toBe(false);
    // Explained, so the page renders "message the farm" rather than a blank.
    expect(response.body.vendor.contactHiddenReason).toMatch(/message them here/i);
  });

  test('hides them from a customer who has never ordered from this farm', async () => {
    const { app } = buildApp(seed());

    const response = await request(app)
      .get('/api/vendors/77')
      .set('Cookie', await sessionCookieFor(CUSTOMER));

    expect(response.body.vendor.phoneNumber).toBe('');
    expect(response.body.vendor.contactVisible).toBe(false);
  });

  test('reveals them once there is a paid order between the two', async () => {
    const { app } = buildApp(seed({ orders: [paidOrder] }));

    const response = await request(app)
      .get('/api/vendors/77')
      .set('Cookie', await sessionCookieFor(CUSTOMER));

    expect(response.body.vendor.contactVisible).toBe(true);
    expect(response.body.vendor.phoneNumber).toBe('0740111222');
  });

  test('an unpaid order is not enough', async () => {
    // Otherwise adding something to a basket harvests the phone number.
    const { app } = buildApp(
      seed({ orders: [{ ...paidOrder, order_state: 'pending_order', paid_at: null }] }),
    );

    const response = await request(app)
      .get('/api/vendors/77')
      .set('Cookie', await sessionCookieFor(CUSTOMER));

    expect(response.body.vendor.contactVisible).toBe(false);
  });

  test('another customer’s order does not reveal them to you', async () => {
    const { app } = buildApp(seed({ orders: [paidOrder] }));

    const response = await request(app)
      .get('/api/vendors/77')
      .set('Cookie', await sessionCookieFor(OTHER_CUSTOMER));

    expect(response.body.vendor.contactVisible).toBe(false);
  });

  test('the farm always sees its own details', async () => {
    const { app } = buildApp(seed());

    const response = await request(app)
      .get('/api/vendors/77')
      .set('Cookie', await sessionCookieFor({ id: '77', role: 'vendor', tokenVersion: 0 }));

    expect(response.body.vendor.contactVisible).toBe(true);
  });

  test('the directory never reveals contact details', async () => {
    // A list page has no order in view, so there is nothing to check against.
    const { app } = buildApp(seed({ orders: [paidOrder] }));

    const response = await request(app)
      .get('/api/vendors')
      .set('Cookie', await sessionCookieFor(CUSTOMER));

    expect(response.body.vendors[0].phoneNumber).toBe('');
    expect(response.body.vendors[0].contactVisible).toBe(false);
    // ...but identification still travels with it.
    expect(response.body.vendors[0].trader.legalName).toBe('POPESCU ION PFA');
  });

  test('empties the fields rather than dropping them', () => {
    // So the frontend renders the explanation instead of a blank where a
    // phone number used to be.
    const hidden = applyContactVisibility({ phoneNumber: '0740', email: 'x@y.z' }, {
      revealContact: false,
    });
    expect(hidden).toHaveProperty('phoneNumber', '');
    expect(hidden).toHaveProperty('email', '');
    expect(hidden.contactHiddenReason).toBeTruthy();
  });
});

describe('OPS-03 — a suspended farm is not published', () => {
  test('answers exactly as a nonexistent one does', async () => {
    const data = seed();
    data.farmers[0].suspended_at = '2026-08-01T00:00:00.000Z';
    data.farmers[0].suspension_effective_at = '2026-08-02T00:00:00.000Z';
    const { app } = buildApp(data);

    const response = await request(app).get('/api/vendors/77');
    expect(response.status).toBe(404);
  });

  test('but keeps selling during the notice period', async () => {
    // P2B art. 4 — notice means they keep trading until it takes effect. That
    // is the point of notice.
    const data = seed();
    data.farmers[0].suspended_at = new Date().toISOString();
    data.farmers[0].suspension_effective_at = new Date(Date.now() + 86400000).toISOString();
    const { app } = buildApp(data);

    const response = await request(app).get('/api/vendors/77');
    expect(response.status).toBe(200);
  });
});
