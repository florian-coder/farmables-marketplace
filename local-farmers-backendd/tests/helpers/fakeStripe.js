// Stripe fals, cât să acopere apelurile pe care le facem noi.
//
// Reține fiecare apel cu tot cu cheia de idempotență, pentru că exact asta
// verifică testele de rambursare: că o reluare nu creează un al doilea
// transfer și nu întoarce banii de două ori.

const createFakeStripe = (overrides = {}) => {
  const calls = {
    refunds: [],
    reversals: [],
    transfers: [],
  };

  const failures = overrides.failures || {};

  const stripeError = (code, message) => {
    const error = new Error(message || code);
    error.type = 'StripeInvalidRequestError';
    error.code = code;
    error.requestId = 'req_fake';
    return error;
  };

  return {
    _calls: calls,
    refunds: {
      async create(params, options) {
        calls.refunds.push({ params, options });
        if (failures.refund) {
          throw stripeError(failures.refund, 'refund failed');
        }
        return { id: `re_${calls.refunds.length}`, ...params };
      },
    },
    transfers: {
      async create(params, options) {
        calls.transfers.push({ params, options });
        if (failures.transfer) {
          throw stripeError(failures.transfer, 'transfer failed');
        }
        return { id: `tr_${calls.transfers.length}`, ...params };
      },
      async createReversal(transferId, params, options) {
        calls.reversals.push({ transferId, params, options });
        if (failures.reversal) {
          throw stripeError(failures.reversal, 'reversal failed');
        }
        return { id: `trr_${calls.reversals.length}`, ...params };
      },
    },
    checkout: {
      sessions: {
        async create(params, options) {
          return { id: 'cs_fake', url: 'https://stripe.test/session', ...params, options };
        },
        async retrieve(id) {
          return { id, status: 'open', url: 'https://stripe.test/session' };
        },
      },
    },
  };
};

module.exports = { createFakeStripe };
