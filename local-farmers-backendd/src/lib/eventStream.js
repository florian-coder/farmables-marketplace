// SEC-01 — moving Realtime off the browser.
//
// The browser used to subscribe to Supabase Realtime directly with the
// publishable key. That is why RLS could not be enabled on `orders` and
// `messages`: our sessions are custom HMAC cookies, not Supabase Auth, so
// there is no `auth.uid()` for a policy to check — and the moment RLS went on
// with no policies, the browser's subscription would see nothing.
//
// Which left the actual problem: **the publishable key in the JS bundle could
// read and write those tables directly.** Not "could subscribe to" — could
// `select` and `insert`. Every order, every message, every conversation, for
// everybody.
//
// So the subscription moves here. One connection per backend process, using
// the service role key, fanned out to browsers over Server-Sent Events. The
// browser gets the same liveness and none of the access:
//
//   Postgres → Supabase Realtime → this process → SSE → browser
//
// The browser never learns another user's id, never holds a database key, and
// the fan-out decides who is allowed to hear about a row — which is a policy
// we can actually express, unlike an RLS rule with no `auth.uid()`.
//
// Multiple instances are fine: each holds its own subscription and its own
// clients, and a change is delivered to whichever instance a browser is
// attached to.

const { supabase, TABLES } = require('./supabase');

/** userId -> Set of open SSE responses. */
const clients = new Map();

/**
 * Topics a browser can be told about. Deliberately coarse: every listener in
 * the frontend does the same thing — refetch — so the event carries "what kind
 * of thing changed", never the row itself. Sending the row would put us right
 * back to leaking data we have not authorised.
 */
const TOPICS = Object.freeze({
  ORDERS: 'orders',
  CONVERSATIONS: 'conversations',
  MESSAGES: 'messages',
  PRODUCTS: 'products',
});

let realtimeChannel = null;

const addClient = (userId, res) => {
  const key = String(userId);
  const set = clients.get(key) || new Set();
  set.add(res);
  clients.set(key, set);
  return () => {
    const current = clients.get(key);
    if (!current) return;
    current.delete(res);
    if (current.size === 0) {
      clients.delete(key);
    }
  };
};

/** Push one event to every open stream for these users. */
const emit = (userIds, topic, detail = {}) => {
  const payload = JSON.stringify({ topic, ...detail, at: Date.now() });

  for (const userId of new Set(userIds.map((id) => String(id)).filter(Boolean))) {
    for (const res of clients.get(userId) || []) {
      try {
        res.write(`event: change\ndata: ${payload}\n\n`);
      } catch (error) {
        // A dead socket is not an error worth logging on every event; the
        // close handler will unregister it.
      }
    }
  }
};

/**
 * Who cares about a row.
 *
 * Some tables carry the user ids directly; `order_replies` and `messages`
 * carry only a parent id, so they cost one lookup. That lookup happens on the
 * server, with the service role, which is exactly the access the browser is
 * no longer allowed to have.
 */
const recipientsFor = async (table, row) => {
  if (!row) return [];

  if (table === TABLES.orders) {
    return [row.client_id, row.farmer_id];
  }
  if (table === TABLES.conversations) {
    return [row.customer_id, row.vendor_id];
  }
  if (table === TABLES.products) {
    return [row.farmer_id];
  }
  if (table === TABLES.orderReplies) {
    const { data } = await supabase
      .from(TABLES.orders)
      .select('client_id, farmer_id')
      .eq('id', String(row.order_id))
      .maybeSingle();
    return data ? [data.client_id, data.farmer_id] : [];
  }
  if (table === TABLES.messages) {
    const { data } = await supabase
      .from(TABLES.conversations)
      .select('customer_id, vendor_id')
      .eq('id', String(row.conversation_id))
      .maybeSingle();
    return data ? [data.customer_id, data.vendor_id] : [];
  }

  return [];
};

const TOPIC_FOR_TABLE = {
  [TABLES.orders]: TOPICS.ORDERS,
  [TABLES.orderReplies]: TOPICS.ORDERS,
  [TABLES.conversations]: TOPICS.CONVERSATIONS,
  [TABLES.messages]: TOPICS.MESSAGES,
  [TABLES.products]: TOPICS.PRODUCTS,
};

const handleChange = async (table, payload) => {
  try {
    // `old` on a delete, `new` on everything else.
    const row = payload?.new && Object.keys(payload.new).length > 0 ? payload.new : payload?.old;
    const recipients = await recipientsFor(table, row);
    if (recipients.length === 0) {
      return;
    }
    emit(recipients, TOPIC_FOR_TABLE[table] || table, {
      // Enough for the client to decide what to refetch, never the row itself.
      id: row?.id ? String(row.id) : undefined,
      conversationId: row?.conversation_id ? String(row.conversation_id) : undefined,
      orderId: row?.order_id ? String(row.order_id) : undefined,
    });
  } catch (error) {
    console.error(`[events] Failed to fan out a ${table} change:`, error?.message || error);
  }
};

/**
 * Open the one Realtime subscription this process needs.
 *
 * Safe to call when Realtime is not configured: the subscription simply never
 * fires, the SSE endpoint still works, and the client's slow fallback poll
 * covers liveness. That degradation is deliberate — a missing publication must
 * not take the app down.
 */
const startEventStream = () => {
  if (realtimeChannel) {
    return realtimeChannel;
  }

  const watched = [
    TABLES.orders,
    TABLES.orderReplies,
    TABLES.conversations,
    TABLES.messages,
    TABLES.products,
  ];

  let channel = supabase.channel('backend-fanout');
  for (const table of watched) {
    channel = channel.on(
      'postgres_changes',
      { event: '*', schema: 'public', table },
      (payload) => {
        handleChange(table, payload).catch(() => {});
      },
    );
  }

  realtimeChannel = channel.subscribe((status) => {
    if (status === 'SUBSCRIBED') {
      console.log('[events] Realtime fan-out is live.');
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
      console.error(
        `[events] Realtime fan-out is ${status}. Live updates fall back to the client poll.`,
      );
    }
  });

  return realtimeChannel;
};

const stopEventStream = () => {
  if (realtimeChannel) {
    supabase.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
};

/** For the diagnostics endpoint and for tests. */
const connectedClientCount = () => {
  let total = 0;
  for (const set of clients.values()) {
    total += set.size;
  }
  return total;
};

module.exports = {
  TOPICS,
  addClient,
  emit,
  recipientsFor,
  handleChange,
  startEventStream,
  stopEventStream,
  connectedClientCount,
};
