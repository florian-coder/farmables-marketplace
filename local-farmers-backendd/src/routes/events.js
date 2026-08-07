// SEC-01 — the browser's live channel, without a database key.
//
// Server-Sent Events rather than WebSockets, on purpose:
//
//   * the traffic is entirely one-way — the browser only ever needs to be
//     told "something you care about changed, refetch";
//   * it is plain HTTP, so the existing cookie authentication, CORS and
//     proxy setup all apply unchanged, with no second auth mechanism to get
//     wrong;
//   * `EventSource` reconnects by itself, which is most of what a WebSocket
//     client library would have been for.
//
// The stream carries no row data. A topic name is enough for every listener in
// the frontend, and shipping rows would recreate exactly the leak this
// replaces.

const express = require('express');

const { requireAuth } = require('../middleware/auth');
const { addClient, TOPICS } = require('../lib/eventStream');

const router = express.Router();

/**
 * Heartbeat interval.
 *
 * Render, nginx and most corporate proxies drop an idle connection somewhere
 * around a minute. A comment line every 25 seconds keeps it open and costs two
 * bytes; without it `EventSource` reconnects every minute, which is not broken
 * but is a lot of pointless connection churn.
 */
const HEARTBEAT_MS = 25000;

router.get('/stream', requireAuth, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Nginx buffers proxied responses by default, which holds events until the
    // buffer fills — the one setting that makes SSE look broken in production
    // while working perfectly in development.
    'X-Accel-Buffering': 'no',
  });

  // Tell the client how long to wait before reconnecting, and confirm the
  // stream is live so it can stop showing a "connecting" state.
  res.write('retry: 5000\n');
  res.write(`event: ready\ndata: ${JSON.stringify({ topics: Object.values(TOPICS) })}\n\n`);

  const unregister = addClient(req.user.id, res);

  const heartbeat = setInterval(() => {
    try {
      res.write(': keep-alive\n\n');
    } catch (error) {
      clearInterval(heartbeat);
    }
  }, HEARTBEAT_MS);
  if (typeof heartbeat.unref === 'function') {
    heartbeat.unref();
  }

  const close = () => {
    clearInterval(heartbeat);
    unregister();
  };

  req.on('close', close);
  req.on('error', close);
});

module.exports = router;
