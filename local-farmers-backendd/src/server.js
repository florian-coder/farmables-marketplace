require('dotenv').config();

const app = require('./app');
const { startOutboxWorker } = require('./lib/outbox');
const { startOrderMaintenance } = require('./lib/orderMaintenance');
const { missingOperatorFields } = require('./lib/operator');
const { startEventStream } = require('./lib/eventStream');

const port = Number(process.env.PORT) || 3000;

app.listen(port, () => {
  console.log(`API listening on port ${port}`);

  // OPS-02 — the outbox drains here, in the web process, on a timer.
  //
  // Not a separate worker: on Render that is a second paid service to keep
  // warm for a queue that is a handful of rows an hour. `for update skip
  // locked` in `claim_due_emails` already makes it safe to run in several
  // instances at once, so scaling out does not send anything twice. The day
  // this becomes a real volume, moving the same function into its own process
  // is a deployment change, not a code change.
  startOutboxWorker({ intervalMs: Number(process.env.OUTBOX_INTERVAL_MS) || 30000 });

  // SEC-01 — one Realtime subscription per process, fanned out to browsers
  // over SSE. This is what lets RLS go on `orders` and `messages`: the browser
  // no longer needs — or has — a database key.
  startEventStream();

  // OPS-04 — orders that reached the door and were never confirmed close
  // themselves, after a warning. Hourly is plenty for a deadline in days.
  startOrderMaintenance({ intervalMs: Number(process.env.MAINTENANCE_INTERVAL_MS) || 3600000 });

  // LEG-02 — the operator identification block is a legal requirement, and a
  // placeholder in production is a compliance gap that nobody notices because
  // nobody reads their own footer. Say it at boot instead.
  const missing = missingOperatorFields();
  if (missing.length > 0) {
    console.warn(
      `[operator] Operator identification is incomplete: ${missing.join(', ')}. ` +
        'These appear in the site footer and in every transactional email. ' +
        'Set the OPERATOR_* environment variables.',
    );
  }
});
