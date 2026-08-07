const {
  ORDER_STATES,
  actorForRole,
  allowedTransitions,
  evaluateTransition,
} = require('../src/lib/orderState');

describe('OPS-01b — the order state machine', () => {
  test('maps account roles onto actors', () => {
    expect(actorForRole('vendor')).toBe('farmer');
    expect(actorForRole('customer')).toBe('customer');
    expect(actorForRole('admin')).toBeNull();
    expect(actorForRole(undefined)).toBeNull();
  });

  test('an invalid transition is 409, not 400', () => {
    // The request is well formed; the order is simply not there any more.
    const verdict = evaluateTransition({
      actor: 'customer',
      from: 'placed_order',
      to: 'in_transit',
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.status).toBe(409);
    expect(verdict.code).toBe('invalid_transition');
  });

  test('a state that does not exist at all is still 400', () => {
    const verdict = evaluateTransition({
      actor: 'customer',
      from: 'placed_order',
      to: 'teleported',
    });

    expect(verdict.status).toBe(400);
    expect(verdict.code).toBe('unknown_state');
  });

  test('re-sending the state an order is already in is a conflict', () => {
    const verdict = evaluateTransition({
      actor: 'farmer',
      from: 'in_transit',
      to: 'in_transit',
    });

    expect(verdict.status).toBe(409);
    expect(verdict.code).toBe('already_in_state');
  });

  test('a finished order cannot be moved by the parties to it', () => {
    for (const actor of ['customer', 'farmer']) {
      const verdict = evaluateTransition({ actor, from: 'received', to: 'cancelled' });
      expect(verdict.ok).toBe(false);
      expect(verdict.status).toBe(409);
      expect(verdict.code).toBe('order_finalised');
    }
  });

  test('an admin can still reverse a received order — that is the dispute path', () => {
    const verdict = evaluateTransition({ actor: 'admin', from: 'received', to: 'cancelled' });
    expect(verdict.ok).toBe(true);
    expect(verdict.refundRequired).toBe(true);
  });

  test('a legal edge made by the wrong party is 403, not 409', () => {
    // Marking an order "in transit" is a real transition — just not one the
    // customer gets to make. Saying 409 here would tell them to reload.
    const verdict = evaluateTransition({
      actor: 'customer',
      from: 'preparing_order',
      to: 'in_transit',
    });

    expect(verdict.status).toBe(403);
    expect(verdict.code).toBe('actor_not_allowed');
  });

  test('cancelling a paid order requires a refund; cancelling a cart does not', () => {
    const paid = evaluateTransition({ actor: 'farmer', from: 'preparing_order', to: 'cancelled' });
    expect(paid.ok).toBe(false); // farmers cannot cancel once they are preparing
    expect(paid.status).toBe(403);

    const declined = evaluateTransition({
      actor: 'farmer',
      from: 'received_by_farmer',
      to: 'cancelled',
    });
    expect(declined.ok).toBe(true);
    expect(declined.refundRequired).toBe(true);
    expect(declined.releasesStock).toBe(true);
    expect(declined.deletesRow).toBe(false);

    const cart = evaluateTransition({ actor: 'customer', from: 'placed_order', to: 'cancelled' });
    expect(cart.ok).toBe(true);
    expect(cart.refundRequired).toBe(false);
    expect(cart.deletesRow).toBe(true);
  });

  test('an unpaid order cancelled before payment releases stock but owes nothing', () => {
    const verdict = evaluateTransition({
      actor: 'customer',
      from: 'pending_order',
      to: 'cancelled',
    });

    expect(verdict.ok).toBe(true);
    // `process_checkout` already reserved the stock at this point.
    expect(verdict.releasesStock).toBe(true);
    // ...but the card has not cleared, so there is nothing to give back.
    expect(verdict.refundRequired).toBe(false);
  });

  test('the actions offered to each side match what they may actually do', () => {
    expect(allowedTransitions('customer', 'arrived')).toEqual([
      { nextState: 'received', label: 'Confirm received' },
    ]);

    const farmerActions = allowedTransitions('farmer', 'received_by_farmer');
    expect(farmerActions).toEqual([
      { nextState: 'preparing_order', label: 'Preparing order' },
      { nextState: 'cancelled', label: 'Decline order' },
    ]);

    // The same edge, worded for whoever is looking at it.
    expect(allowedTransitions('customer', 'pending_order')[0].label).toBe('Cancel order');
    expect(allowedTransitions('farmer', 'pending_order')[0].label).toBe('Decline order');
  });

  test('every transition names states that exist', () => {
    for (const state of ORDER_STATES) {
      for (const actor of ['customer', 'farmer', 'admin', 'system']) {
        for (const action of allowedTransitions(actor, state)) {
          expect(ORDER_STATES).toContain(action.nextState);
        }
      }
    }
  });
});
