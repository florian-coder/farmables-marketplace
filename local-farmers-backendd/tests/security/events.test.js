// SEC-01 — the live channel that replaced the browser's database key.
//
// What this has to get right, because RLS depends on it:
//   1. only signed-in users get a stream at all;
//   2. an event reaches exactly the people party to the row, and nobody else;
//   3. the event carries no row content — a topic and an id, never a message.
//
// (3) is the one worth guarding. The whole point of moving the subscription
// server-side was that the browser stopped receiving rows it was not entitled
// to; shipping the row over SSE instead would put us straight back.

const request = require('supertest');

const { buildApp, sessionCookieFor } = require('../helpers/appHarness');

const CUSTOMER = { id: '10', role: 'customer', tokenVersion: 0 };

const seed = () => ({
  users: [
    { id: '10', username: 'ana', email: 'ana@example.com', user_type: 'client', token_version: 0 },
    { id: '77', username: 'ferma', email: 'ferma@example.com', user_type: 'farmer', token_version: 0 },
    { id: '99', username: 'radu', email: 'radu@example.com', user_type: 'client', token_version: 0 },
  ],
  orders: [{ id: 'ord-1', client_id: '10', farmer_id: '77', order_state: 'received_by_farmer' }],
  conversations: [{ id: 'conv-1', customer_id: '10', vendor_id: '77' }],
  messages: [{ id: 'msg-1', conversation_id: 'conv-1', sender_user_id: '77', text: 'On my way' }],
  order_replies: [{ id: 'rep-1', order_id: 'ord-1', sender_user_id: '77', message: 'Packed' }],
  products: [{ id: 'p-1', farmer_id: '77', 'product name': 'Rosii' }],
});

describe('SEC-01 — who may open a stream', () => {
  test('a signed-out browser gets nothing', async () => {
    const { app } = buildApp(seed());
    const response = await request(app).get('/api/events/stream');
    expect(response.status).toBe(401);
  });

  test('a signed-in browser gets an event stream', async () => {
    const { app } = buildApp(seed());

    const response = await request(app)
      .get('/api/events/stream')
      .set('Cookie', await sessionCookieFor(CUSTOMER))
      // supertest waits for the response to end; SSE never ends, so the
      // request is aborted once the headers and first frame have arrived.
      .buffer(false)
      .parse((res, callback) => {
        res.on('data', () => res.destroy());
        res.on('close', () => callback(null, ''));
      });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/event-stream/);
    // Nginx buffers proxied responses by default, which holds events until the
    // buffer fills — SSE looks broken in production and fine locally.
    expect(response.headers['x-accel-buffering']).toBe('no');
  });
});

describe('SEC-01 — who hears about a change', () => {
  const loadStream = (seedData) => {
    const { fake } = buildApp(seedData);
    // eslint-disable-next-line global-require
    const eventStream = require('../../src/lib/eventStream');
    return { eventStream, fake };
  };

  test('an order reaches its customer and its farm, and nobody else', async () => {
    const { eventStream } = loadStream(seed());

    const recipients = await eventStream.recipientsFor('orders', {
      id: 'ord-1',
      client_id: '10',
      farmer_id: '77',
    });

    expect(recipients.sort()).toEqual(['10', '77']);
    expect(recipients).not.toContain('99');
  });

  test('a reply is resolved through its order, on the server', async () => {
    // The browser cannot be trusted to say whose order this is, and it no
    // longer has the access to find out. The lookup happens here, with the
    // service role — exactly the access the browser lost.
    const { eventStream } = loadStream(seed());

    const recipients = await eventStream.recipientsFor('order_replies', {
      id: 'rep-1',
      order_id: 'ord-1',
    });

    expect(recipients.sort()).toEqual(['10', '77']);
  });

  test('a message is resolved through its conversation', async () => {
    const { eventStream } = loadStream(seed());

    const recipients = await eventStream.recipientsFor('messages', {
      id: 'msg-1',
      conversation_id: 'conv-1',
    });

    expect(recipients.sort()).toEqual(['10', '77']);
    expect(recipients).not.toContain('99');
  });

  test('a product change reaches only its farm', async () => {
    const { eventStream } = loadStream(seed());

    const recipients = await eventStream.recipientsFor('products', {
      id: 'p-1',
      farmer_id: '77',
    });

    expect(recipients).toEqual(['77']);
  });

  test('an orphaned row reaches nobody rather than everybody', async () => {
    const { eventStream } = loadStream(seed());

    expect(
      await eventStream.recipientsFor('messages', { conversation_id: 'does-not-exist' }),
    ).toEqual([]);
    expect(await eventStream.recipientsFor('unknown_table', { id: 'x' })).toEqual([]);
    expect(await eventStream.recipientsFor('orders', null)).toEqual([]);
  });
});

describe('SEC-01 — what the stream is allowed to carry', () => {
  test('sends a topic and ids, never row content', async () => {
    const { fake } = buildApp(seed());
    // eslint-disable-next-line global-require
    const eventStream = require('../../src/lib/eventStream');

    const written = [];
    const fakeResponse = { write: (chunk) => written.push(chunk) };
    const unregister = eventStream.addClient('10', fakeResponse);

    await eventStream.handleChange('messages', {
      new: { id: 'msg-1', conversation_id: 'conv-1', text: 'Secret plans' },
    });

    unregister();
    expect(fake).toBeDefined();

    const frame = written.join('');
    expect(frame).toContain('event: change');
    expect(frame).toContain('"topic":"messages"');
    expect(frame).toContain('"conversationId":"conv-1"');
    // The message body must not travel. Shipping rows over the new channel
    // would recreate exactly the leak the old one was.
    expect(frame).not.toContain('Secret plans');
  });

  test('does not write to a client who is not party to the row', async () => {
    buildApp(seed());
    // eslint-disable-next-line global-require
    const eventStream = require('../../src/lib/eventStream');

    const stranger = [];
    const unregister = eventStream.addClient('99', { write: (chunk) => stranger.push(chunk) });

    await eventStream.handleChange('orders', {
      new: { id: 'ord-1', client_id: '10', farmer_id: '77' },
    });

    unregister();
    expect(stranger).toHaveLength(0);
  });

  test('a closed connection is unregistered rather than accumulating', async () => {
    buildApp(seed());
    // eslint-disable-next-line global-require
    const eventStream = require('../../src/lib/eventStream');

    const before = eventStream.connectedClientCount();
    const unregister = eventStream.addClient('10', { write: () => {} });
    expect(eventStream.connectedClientCount()).toBe(before + 1);

    unregister();
    expect(eventStream.connectedClientCount()).toBe(before);
  });

  test('a socket that throws on write does not break the fan-out', async () => {
    buildApp(seed());
    // eslint-disable-next-line global-require
    const eventStream = require('../../src/lib/eventStream');

    const healthy = [];
    const stopBroken = eventStream.addClient('10', {
      write: () => {
        throw new Error('EPIPE');
      },
    });
    const stopHealthy = eventStream.addClient('77', { write: (chunk) => healthy.push(chunk) });

    await eventStream.handleChange('orders', {
      new: { id: 'ord-1', client_id: '10', farmer_id: '77' },
    });

    stopBroken();
    stopHealthy();
    // One dead socket must not cost the farm its notification.
    expect(healthy.length).toBeGreaterThan(0);
  });
});
