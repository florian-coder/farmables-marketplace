// OPS-07 (chat moderation) + OPS-03 (disputes).
//
// The design decision these guard: **the filter flags, it does not block.** A
// farmer and a customer arranging a delivery legitimately swap phone numbers
// and addresses. A filter that refused those would break the commonest
// conversation on the platform to catch a rare one — so a flagged message is
// delivered, the sender is warned about what they are giving up, and a report
// is raised.
//
// The one hard stop is a block, and it is silent: a block that announces
// itself invites retaliation through some other channel.

const request = require('supertest');

const { buildApp, browserHeaders, sessionCookieFor, adminCookie } = require('../helpers/appHarness');
const { inspectMessage } = require('../../src/lib/moderation');

const CUSTOMER = { id: '10', role: 'customer', tokenVersion: 0 };
const VENDOR = { id: '77', role: 'vendor', tokenVersion: 0 };

const seed = (overrides = {}) => ({
  users: [
    { id: '10', username: 'ana', email: 'ana@example.com', user_type: 'client', token_version: 0 },
    { id: '77', username: 'ferma', email: 'ferma@example.com', user_type: 'farmer', token_version: 0 },
  ],
  customers: [{ id: '10', name: 'Ana', surname: 'Pop' }],
  farmers: [{ id: '77', 'farm name': 'Gradina Verde', charges_enabled: true }],
  conversations: [
    { id: 'conv-1', customer_id: '10', vendor_id: '77', unread_for_customer: 0, unread_for_vendor: 0 },
  ],
  messages: [
    { id: 'msg-1', conversation_id: 'conv-1', sender_user_id: '77', text: 'Ready tomorrow', created_at: '2026-08-01' },
  ],
  message_reports: [],
  user_blocks: [],
  disputes: [],
  dispute_evidence: [],
  orders: [
    {
      id: 'ord-1',
      client_id: '10',
      farmer_id: '77',
      checkout_id: 'chk-1',
      order_state: 'arrived',
      products_subtotal_bani: 10000,
      delivery_fee_bani: 1500,
      commission_bani: 1000,
      transfer_amount_bani: 11500,
      paid_at: '2026-08-01T00:00:00.000Z',
    },
  ],
  audit_log: [],
  ...overrides,
});

const sendMessage = async (app, user, text) =>
  request(app)
    .post('/api/chat/conversations/conv-1/messages')
    .set(browserHeaders)
    .set('Cookie', await sessionCookieFor(user))
    .send({ text });

describe('OPS-07 — what the filter catches', () => {
  test('flags steering the deal off-platform, hardest of all', () => {
    // Not because of our commission: a customer who pays cash at the gate has
    // no refund, no dispute process and no traceability record, and finds that
    // out only when something goes wrong.
    for (const text of [
      'Can you pay cash when I deliver?',
      'Trimite-mi pe Revolut, fara comision',
      'pay me directly and skip the site',
    ]) {
      const result = inspectMessage(text);
      expect(result.flagged).toBe(true);
      expect(result.severity).toBe('high');
      expect(result.kinds).toContain('off_platform_payment');
    }
  });

  test('flags contact details gently, because sharing them is normal', () => {
    const result = inspectMessage('Call me on 0740 111 222 when you arrive');
    expect(result.flagged).toBe(true);
    // Low, not high: arranging a delivery is the point of the chat.
    expect(result.severity).toBe('low');
  });

  test('leaves ordinary messages alone', () => {
    for (const text of [
      'Are the tomatoes ready this week?',
      'I will be home after 5pm, thanks!',
      'Can you add another kilo of onions?',
    ]) {
      expect(inspectMessage(text).flagged).toBe(false);
    }
  });
});

describe('OPS-07 — flagged messages are delivered', () => {
  test('sends the message and warns the sender', async () => {
    const { app, fake } = buildApp(seed());

    const response = await sendMessage(app, CUSTOMER, 'Can I pay cash instead?');

    expect(response.status).toBe(201);
    expect(response.body.message.text).toBe('Can I pay cash instead?');
    // Explaining what they give up works better than refusing to send it.
    expect(response.body.warning).toMatch(/refund protection/i);
    expect(fake._db.messages).toHaveLength(2);
  });

  test('a high-severity flag raises a report without anyone reporting it', async () => {
    // Waiting for the customer to notice and report is waiting for the harm.
    const { app, fake } = buildApp(seed());

    await sendMessage(app, VENDOR, 'Plateste-mi cash, fara comision');

    const report = fake._db.message_reports[0];
    expect(report).toBeDefined();
    expect(report.reporter_user_id).toBe('system');
    expect(report.reported_user_id).toBe('77');
    expect(report.reason).toBe('off_platform_payment');
  });

  test('an ordinary message raises nothing and warns nobody', async () => {
    const { app, fake } = buildApp(seed());

    const response = await sendMessage(app, CUSTOMER, 'See you at 5, thank you!');

    expect(response.status).toBe(201);
    expect(response.body.warning).toBeUndefined();
    expect(fake._db.message_reports).toHaveLength(0);
  });
});

describe('OPS-07 — blocking', () => {
  test('a block stops delivery, without saying so', async () => {
    const data = seed({
      user_blocks: [{ id: 'b-1', blocker_user_id: '10', blocked_user_id: '77' }],
    });
    const { app, fake } = buildApp(data);

    const response = await sendMessage(app, VENDOR, 'Hello again');

    expect(response.status).toBe(403);
    // "Could not be delivered", never "you are blocked": telling them invites
    // retaliation through some other channel.
    expect(response.body.error).not.toMatch(/block/i);
    expect(fake._db.messages).toHaveLength(1);
  });

  test('blocking works in both directions once set', async () => {
    const data = seed({
      user_blocks: [{ id: 'b-1', blocker_user_id: '10', blocked_user_id: '77' }],
    });
    const { app } = buildApp(data);

    // The person who blocked also stops being able to write into that thread —
    // a one-sided conversation is not a conversation.
    const response = await sendMessage(app, CUSTOMER, 'Actually, one more thing');
    expect(response.status).toBe(403);
  });

  test('a customer can block, list and unblock', async () => {
    const { app, fake } = buildApp(seed());
    const cookie = await sessionCookieFor(CUSTOMER);

    const blocked = await request(app)
      .post('/api/chat/blocks')
      .set(browserHeaders)
      .set('Cookie', cookie)
      .send({ userId: '77', reason: 'Rude' });
    expect(blocked.status).toBe(201);

    const list = await request(app).get('/api/chat/blocks').set('Cookie', cookie);
    expect(list.body.blocks).toHaveLength(1);
    expect(list.body.blocks[0].userId).toBe('77');

    const unblocked = await request(app)
      .delete('/api/chat/blocks/77')
      .set(browserHeaders)
      .set('Cookie', cookie);
    expect(unblocked.status).toBe(200);
    expect(fake._db.user_blocks).toHaveLength(0);
  });

  test('you cannot block yourself', async () => {
    const { app } = buildApp(seed());

    const response = await request(app)
      .post('/api/chat/blocks')
      .set(browserHeaders)
      .set('Cookie', await sessionCookieFor(CUSTOMER))
      .send({ userId: '10' });

    expect(response.status).toBe(400);
  });
});

describe('OPS-07 — reporting', () => {
  const report = async (app, user, body) =>
    request(app)
      .post('/api/chat/messages/msg-1/report')
      .set(browserHeaders)
      .set('Cookie', await sessionCookieFor(user))
      .send({ reason: 'abuse', ...body });

  test('records the report with a snapshot of the text', async () => {
    // The account may be deleted — GDPR Art. 17 replaces the body with a
    // placeholder — long before anyone reviews it.
    const { app, fake } = buildApp(seed());

    const response = await report(app, CUSTOMER, { detail: 'Threatening' });

    expect(response.status).toBe(201);
    const stored = fake._db.message_reports[0];
    expect(stored.message_snapshot).toBe('Ready tomorrow');
    expect(stored.reported_user_id).toBe('77');
    expect(stored.reporter_user_id).toBe('10');
  });

  test('reporting twice is a mis-click, not a stronger signal', async () => {
    const { app, fake } = buildApp(seed());

    await report(app, CUSTOMER);
    const second = await report(app, CUSTOMER);

    expect(second.status).toBe(200);
    expect(second.body.alreadyReported).toBe(true);
    expect(fake._db.message_reports).toHaveLength(1);
  });

  test('you cannot report your own message', async () => {
    const { app } = buildApp(seed());
    const response = await report(app, VENDOR);
    expect(response.status).toBe(400);
  });

  test('someone outside the conversation cannot report into it', async () => {
    // Otherwise the endpoint confirms whether a given message id exists.
    const data = seed();
    data.users.push({ id: '99', username: 'radu', user_type: 'client', token_version: 0 });
    const { app } = buildApp(data);

    const response = await report(app, { id: '99', role: 'customer', tokenVersion: 0 });
    expect(response.status).toBe(403);
  });

  test('an unknown reason is refused', async () => {
    const { app } = buildApp(seed());
    const response = await report(app, CUSTOMER, { reason: 'because' });
    expect(response.status).toBe(400);
  });
});

describe('OPS-03 — opening a dispute', () => {
  const openCase = async (app, user, body) =>
    request(app)
      .post('/api/disputes')
      .set(browserHeaders)
      .set('Cookie', await sessionCookieFor(user))
      .send({ orderId: 'ord-1', category: 'missing_items', description: 'Two kilos short', ...body });

  test('opens a case with a 48-hour clock on the farm', async () => {
    const { app, fake } = buildApp(seed());

    const response = await openCase(app, CUSTOMER);

    expect(response.status).toBe(201);
    expect(response.body.dispute.state).toBe('awaiting_farmer');

    const respondBy = Date.parse(fake._db.disputes[0].respond_by);
    const hours = (respondBy - Date.now()) / (60 * 60 * 1000);
    expect(hours).toBeGreaterThan(47);
    expect(hours).toBeLessThan(49);
  });

  test('cannot be opened before the order has arrived', async () => {
    const data = seed();
    data.orders[0].order_state = 'preparing_order';
    const { app } = buildApp(data);

    const response = await openCase(app, CUSTOMER);

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('window_closed');
    // "Not yet" and "too late" are different problems and only one of them is
    // something the customer can act on.
    expect(response.body.error).toMatch(/once the order has been marked as delivered/i);
  });

  test('a cancelled order points them somewhere useful instead', async () => {
    const data = seed();
    data.orders[0].order_state = 'cancelled';
    const { app } = buildApp(data);

    const response = await openCase(app, CUSTOMER);
    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/cancelled/i);
  });

  test('a second complaint about the same order joins the first case', async () => {
    const { app, fake } = buildApp(seed());

    await openCase(app, CUSTOMER);
    const second = await openCase(app, CUSTOMER, { category: 'quality' });

    expect(second.status).toBe(409);
    expect(second.body.code).toBe('already_open');
    expect(fake._db.disputes).toHaveLength(1);
  });

  test('someone outside the order cannot open a case on it', async () => {
    const data = seed();
    data.users.push({ id: '99', username: 'radu', user_type: 'client', token_version: 0 });
    const { app } = buildApp(data);

    const response = await openCase(app, { id: '99', role: 'customer', tokenVersion: 0 });
    expect(response.status).toBe(403);
  });

  test('an unknown category is refused', async () => {
    const { app } = buildApp(seed());
    const response = await openCase(app, CUSTOMER, { category: 'vibes' });
    expect(response.status).toBe(400);
  });
});

describe('OPS-03 — the 48-hour clock', () => {
  test('escalates a case the farm let run past its deadline', async () => {
    // A farmer who stops replying must not be able to run out the clock.
    const data = seed({
      disputes: [
        {
          id: 'disp-1',
          order_id: 'ord-1',
          customer_id: '10',
          farmer_id: '77',
          opened_by: 'customer',
          category: 'missing_items',
          state: 'awaiting_farmer',
          respond_by: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        },
      ],
    });
    const { fake } = buildApp(data);
    // eslint-disable-next-line global-require
    const { escalateOverdueDisputes } = require('../../src/lib/disputes');

    const escalated = await escalateOverdueDisputes();

    expect(escalated).toBe(1);
    expect(fake._db.disputes[0].state).toBe('escalated');
    expect(fake._db.disputes[0].escalated_at).toBeTruthy();
  });

  test('leaves a case still inside its window alone', async () => {
    const data = seed({
      disputes: [
        {
          id: 'disp-1',
          order_id: 'ord-1',
          customer_id: '10',
          farmer_id: '77',
          opened_by: 'customer',
          category: 'quality',
          state: 'awaiting_farmer',
          respond_by: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        },
      ],
    });
    const { fake } = buildApp(data);
    // eslint-disable-next-line global-require
    const { escalateOverdueDisputes } = require('../../src/lib/disputes');

    expect(await escalateOverdueDisputes()).toBe(0);
    expect(fake._db.disputes[0].state).toBe('awaiting_farmer');
  });

  test('a farm replying after escalation does not take the decision back', async () => {
    const data = seed({
      disputes: [
        {
          id: 'disp-1',
          order_id: 'ord-1',
          customer_id: '10',
          farmer_id: '77',
          opened_by: 'customer',
          category: 'quality',
          state: 'escalated',
          respond_by: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        },
      ],
    });
    const { app, fake } = buildApp(data);

    const response = await request(app)
      .post('/api/disputes/disp-1/respond')
      .set(browserHeaders)
      .set('Cookie', await sessionCookieFor(VENDOR))
      .send({ response: 'Sorry, we were away' });

    expect(response.status).toBe(200);
    // Replying is welcome; it does not un-escalate.
    expect(fake._db.disputes[0].state).toBe('escalated');
    expect(fake._db.disputes[0].farmer_response).toBe('Sorry, we were away');
  });
});

describe('OPS-03 — admin access to a private conversation', () => {
  test('needs a reason and a case to point at', async () => {
    // The most invasive thing an admin can do here, so it is the most tightly
    // bound.
    const { app } = buildApp(seed());
    const cookie = adminCookie();

    const noReason = await request(app)
      .get('/api/admin/conversations/conv-1?disputeId=disp-1')
      .set('Cookie', cookie);
    expect(noReason.status).toBe(400);
    expect(noReason.body.code).toBe('reason_required');

    const noContext = await request(app)
      .get('/api/admin/conversations/conv-1?reason=checking')
      .set('Cookie', cookie);
    expect(noContext.status).toBe(400);
    expect(noContext.body.code).toBe('context_required');
  });

  test('logs the access before returning a single message', async () => {
    const { app, fake } = buildApp(seed());

    const response = await request(app)
      .get('/api/admin/conversations/conv-1?reason=missing+items+case&disputeId=disp-1')
      .set('Cookie', adminCookie({ username: 'ana.admin' }));

    expect(response.status).toBe(200);
    expect(response.body.messages).toHaveLength(1);
    expect(response.body.accessLogged).toBe(true);

    const entry = fake._db.audit_log.find((row) => row.action === 'conversation.viewed');
    expect(entry.actor_id).toBe('ana.admin');
    expect(entry.entity_id).toBe('conv-1');
    expect(entry.new_value).toContain('missing items case');
  });
});

describe('OPS-03 — suspending a farm', () => {
  test('requires a statement of reasons and gives 30 days by default', async () => {
    // P2B art. 4. Notice is the default so the compliant path is the easy one.
    const { app, fake } = buildApp(seed());

    const noReason = await request(app)
      .post('/api/admin/farms/77/suspend')
      .set(browserHeaders)
      .set('Cookie', adminCookie())
      .send({});
    expect(noReason.status).toBe(400);
    expect(noReason.body.code).toBe('reason_required');

    const suspended = await request(app)
      .post('/api/admin/farms/77/suspend')
      .set(browserHeaders)
      .set('Cookie', adminCookie())
      .send({ reason: 'Repeated quality complaints' });

    expect(suspended.status).toBe(200);
    expect(suspended.body.noticeGiven).toBe(true);

    const farm = fake._db.farmers[0];
    expect(farm.suspended_reason).toBe('Repeated quality complaints');
    // Notice means they keep selling until it takes effect — that is the point.
    expect(farm.charges_enabled).toBe(true);
  });

  test('an immediate suspension stops sales now, and has to be asked for', async () => {
    const { app, fake } = buildApp(seed());

    const response = await request(app)
      .post('/api/admin/farms/77/suspend')
      .set(browserHeaders)
      .set('Cookie', adminCookie())
      .send({ reason: 'Food safety notice from the authority', immediate: true });

    expect(response.status).toBe(200);
    expect(response.body.noticeGiven).toBe(false);
    expect(fake._db.farmers[0].charges_enabled).toBe(false);
  });

  test('lifting a suspension does not re-enable charges by itself', async () => {
    // `charges_enabled` belongs to Stripe. If Stripe is unhappy for its own
    // reasons, lifting our suspension must not paper over that.
    const data = seed();
    data.farmers[0].charges_enabled = false;
    data.farmers[0].suspended_at = '2026-08-01T00:00:00.000Z';
    const { app, fake } = buildApp(data);

    await request(app)
      .post('/api/admin/farms/77/unsuspend')
      .set(browserHeaders)
      .set('Cookie', adminCookie())
      .send({});

    expect(fake._db.farmers[0].suspended_at).toBeNull();
    expect(fake._db.farmers[0].charges_enabled).toBe(false);
  });
});
