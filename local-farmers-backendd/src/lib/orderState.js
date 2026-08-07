// The order lifecycle, in one place.
//
// Before this file the allowed transitions lived in a lookup table inside
// `routes/orders.js`, which meant every other caller that had to move an order
// — the payment webhook, a refund, the auto-confirm job, an admin acting on a
// dispute — either duplicated the rules or bypassed them. A state machine that
// only one of five callers consults is not a state machine.
//
// Two deliberate choices:
//
//   * An invalid transition is **409 Conflict**, not 400. The request is well
//     formed; the order is simply not in a state where it can happen. That is
//     the difference between "you sent nonsense" and "someone got there first",
//     and a client that retries on 400 but reconciles on 409 needs to be told
//     which one it is. A `nextState` that is not an order state at all is
//     still 400 — that one really is malformed.
//
//   * Actors, not roles. `vendor` is the account role; `farmer` is who acts on
//     the order. `system` and `admin` are actors with no account role at all,
//     and they need the same table rather than a private bypass.

const ORDER_STATES = Object.freeze([
  'placed_order',
  'pending_order',
  'received_by_farmer',
  'preparing_order',
  'in_transit',
  'arrived',
  'received',
  'cancelled',
]);

/** Nothing leaves these. A cancelled order is not resurrected, it is re-ordered. */
const TERMINAL_STATES = Object.freeze(['received', 'cancelled']);

/**
 * States an order can only be in once the card has cleared.
 *
 * Cancelling out of one of these owes the customer money, which is what makes
 * the refund path (OPS-01b) mandatory rather than optional.
 */
const PAID_STATES = Object.freeze([
  'received_by_farmer',
  'preparing_order',
  'in_transit',
  'arrived',
  'received',
]);

/** `placed_order` is the cart. It has no payment and no accounting trace. */
const CART_STATE = 'placed_order';

const ACTORS = Object.freeze(['customer', 'farmer', 'admin', 'system']);

/**
 * The transition table.
 *
 * `labels` is per actor because the same edge reads differently on the two
 * sides: a customer cancels their order, a farmer declines it.
 */
const TRANSITIONS = Object.freeze([
  {
    from: 'placed_order',
    to: 'cancelled',
    actors: ['customer', 'admin'],
    label: 'Empty basket',
  },
  {
    // Written by `process_checkout` when the stock is reserved.
    from: 'placed_order',
    to: 'pending_order',
    actors: ['system'],
    label: 'Reserved for payment',
  },
  {
    from: 'pending_order',
    to: 'cancelled',
    actors: ['customer', 'farmer', 'admin', 'system'],
    label: 'Cancel order',
    labels: { farmer: 'Decline order' },
  },
  {
    // `mark_checkout_paid` — the payment cleared.
    from: 'pending_order',
    to: 'received_by_farmer',
    actors: ['system'],
    label: 'Payment confirmed',
  },
  {
    from: 'received_by_farmer',
    to: 'preparing_order',
    actors: ['farmer', 'admin'],
    label: 'Preparing order',
  },
  {
    from: 'received_by_farmer',
    to: 'cancelled',
    actors: ['farmer', 'admin'],
    label: 'Decline order',
  },
  {
    from: 'preparing_order',
    to: 'in_transit',
    actors: ['farmer', 'admin'],
    label: 'In transit',
  },
  {
    from: 'preparing_order',
    to: 'cancelled',
    actors: ['admin'],
    label: 'Cancel order',
  },
  {
    from: 'in_transit',
    to: 'arrived',
    actors: ['farmer', 'admin'],
    label: 'Arrived',
  },
  {
    from: 'in_transit',
    to: 'cancelled',
    actors: ['admin'],
    label: 'Cancel order',
  },
  {
    from: 'arrived',
    to: 'received',
    // `system` is OPS-04: an order nobody confirmed closes itself after the
    // grace period, otherwise the farmer's money is held hostage by silence.
    actors: ['customer', 'admin', 'system'],
    label: 'Confirm received',
  },
  {
    from: 'arrived',
    to: 'cancelled',
    actors: ['admin'],
    label: 'Cancel order',
  },
  {
    // A dispute resolved in the customer's favour after they confirmed receipt.
    from: 'received',
    to: 'cancelled',
    actors: ['admin'],
    label: 'Reverse order',
  },
]);

/** The account role as stored on `users`, mapped to who is acting. */
const actorForRole = (role) => {
  if (role === 'vendor') {
    return 'farmer';
  }
  if (role === 'customer') {
    return 'customer';
  }
  return null;
};

const isOrderState = (value) => ORDER_STATES.includes(value);
const isTerminal = (state) => TERMINAL_STATES.includes(state);
const isPaidState = (state) => PAID_STATES.includes(state);

const labelFor = (transition, actor) =>
  (transition.labels && transition.labels[actor]) || transition.label;

/** Every move `actor` may make from `fromState`, for the UI's action buttons. */
const allowedTransitions = (actor, fromState) => {
  if (!ACTORS.includes(actor) || !isOrderState(fromState)) {
    return [];
  }
  return TRANSITIONS.filter(
    (transition) => transition.from === fromState && transition.actors.includes(actor),
  ).map((transition) => ({
    nextState: transition.to,
    label: labelFor(transition, actor),
  }));
};

/**
 * Decide whether one move is legal, and say precisely why not when it is not.
 *
 * Returns `{ ok: true, transition, refundRequired, releasesStock }` or
 * `{ ok: false, status, code, error }`. Callers translate that straight into a
 * response — there is no second opinion anywhere.
 */
const evaluateTransition = ({ actor, from, to }) => {
  if (!ACTORS.includes(actor)) {
    return {
      ok: false,
      status: 403,
      code: 'unknown_actor',
      error: 'This account cannot change orders.',
    };
  }
  if (!isOrderState(to)) {
    // Malformed input, not a conflict: no order is ever in this state.
    return {
      ok: false,
      status: 400,
      code: 'unknown_state',
      error: 'Invalid nextState.',
    };
  }
  if (!isOrderState(from)) {
    return {
      ok: false,
      status: 409,
      code: 'unknown_current_state',
      error: 'This order is in a state we do not recognise. Contact support.',
    };
  }
  if (from === to) {
    return {
      ok: false,
      status: 409,
      code: 'already_in_state',
      error: `This order is already ${to.replace(/_/g, ' ')}.`,
    };
  }
  if (isTerminal(from) && !TRANSITIONS.some((t) => t.from === from && t.to === to && t.actors.includes(actor))) {
    return {
      ok: false,
      status: 409,
      code: 'order_finalised',
      error: `This order is ${from} and can no longer be changed.`,
    };
  }

  const transition = TRANSITIONS.find((entry) => entry.from === from && entry.to === to);
  if (!transition) {
    return {
      ok: false,
      status: 409,
      code: 'invalid_transition',
      error: `An order cannot go from ${from.replace(/_/g, ' ')} to ${to.replace(/_/g, ' ')}.`,
    };
  }
  if (!transition.actors.includes(actor)) {
    return {
      ok: false,
      status: 403,
      code: 'actor_not_allowed',
      error: 'You are not allowed to make this change.',
    };
  }

  return {
    ok: true,
    transition,
    label: labelFor(transition, actor),
    // Money left the customer, so cancelling owes it back.
    refundRequired: to === 'cancelled' && isPaidState(from),
    // Stock was reserved by `process_checkout` and must go back on the shelf.
    releasesStock: to === 'cancelled' && from !== CART_STATE,
    // Only an untouched cart is deleted outright; it has nothing to preserve.
    deletesRow: to === 'cancelled' && from === CART_STATE,
  };
};

module.exports = {
  ORDER_STATES,
  TERMINAL_STATES,
  PAID_STATES,
  CART_STATE,
  ACTORS,
  TRANSITIONS,
  actorForRole,
  isOrderState,
  isTerminal,
  isPaidState,
  allowedTransitions,
  evaluateTransition,
};
