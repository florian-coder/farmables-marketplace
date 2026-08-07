// SEC-01 — live updates without a database key in the bundle.
//
// Every page used to open its own Supabase Realtime subscription with the
// publishable key. That key could `select` and `insert` on `orders`,
// `messages` and `conversations` directly — every order and every private
// message, for everybody — and it was in the JS bundle, readable by anyone who
// opened devtools.
//
// Now there is one `EventSource` to our own API, authenticated by the same
// session cookie as everything else. The server decides who hears about what.
//
// The stream carries a topic, never a row. Every listener did the same thing
// with the old payload anyway — refetch — so nothing is lost, and shipping
// rows over the new channel would recreate the leak we just closed.

import { useEffect, useRef } from 'react';

import { getApiBase } from './api.js';

/**
 * A slow poll behind the stream.
 *
 * Realtime depends on the table being in the Postgres publication, which is
 * configured by hand in Supabase. If that is ever wrong, or the connection
 * dies in a way `EventSource` does not notice, this is the difference between
 * "updates are a minute late" and "the page is silently frozen".
 */
const FALLBACK_POLL_MS = 45000;

let sharedSource = null;
let sharedRefCount = 0;
const listeners = new Set();

/**
 * One connection for the whole tab, shared between pages.
 *
 * The nav bar, the orders page and the chat page all want updates at once.
 * Three EventSource connections would mean three of the six connections a
 * browser allows per origin, spent on the same stream.
 */
const ensureSource = () => {
  if (sharedSource) {
    return sharedSource;
  }

  // `withCredentials` is what sends the session cookie cross-origin — the
  // frontend is on Vercel and the API on Render, so this is always a
  // cross-origin request.
  sharedSource = new EventSource(`${getApiBase()}/api/events/stream`, {
    withCredentials: true,
  });

  sharedSource.addEventListener('change', (event) => {
    let payload = {};
    try {
      payload = JSON.parse(event.data);
    } catch (error) {
      return;
    }
    for (const listener of listeners) {
      listener(payload);
    }
  });

  // `EventSource` reconnects on its own, with the `retry:` interval the server
  // sends. Nothing to do here but avoid noise in the console.
  sharedSource.addEventListener('error', () => {});

  return sharedSource;
};

const releaseSource = () => {
  sharedRefCount -= 1;
  if (sharedRefCount <= 0 && sharedSource) {
    sharedSource.close();
    sharedSource = null;
    sharedRefCount = 0;
  }
};

/**
 * Refetch when something in `topics` changes.
 *
 * @param topics   e.g. ['orders'] or ['messages', 'conversations']
 * @param onChange called with the event payload; keep it cheap, it may fire
 *                 several times in a burst
 * @param enabled  false unsubscribes entirely — for signed-out pages
 */
export function useLiveUpdates(topics, onChange, enabled = true) {
  // Held in a ref so a caller passing an inline arrow does not tear the
  // subscription down and rebuild it on every render.
  const handlerRef = useRef(onChange);
  handlerRef.current = onChange;

  const topicKey = Array.isArray(topics) ? topics.join(',') : String(topics || '');

  useEffect(() => {
    if (!enabled || !topicKey) {
      return undefined;
    }

    const wanted = new Set(topicKey.split(','));
    const listener = (payload) => {
      if (wanted.has(payload.topic)) {
        handlerRef.current?.(payload);
      }
    };

    listeners.add(listener);
    sharedRefCount += 1;
    ensureSource();

    const poll = setInterval(() => {
      handlerRef.current?.({ topic: 'poll' });
    }, FALLBACK_POLL_MS);

    return () => {
      listeners.delete(listener);
      clearInterval(poll);
      releaseSource();
    };
  }, [topicKey, enabled]);
}

export const LIVE_TOPICS = Object.freeze({
  ORDERS: 'orders',
  CONVERSATIONS: 'conversations',
  MESSAGES: 'messages',
  PRODUCTS: 'products',
});
