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
    accountsCreated: [],
    accountsRetrieved: [],
    accountLinks: [],
    loginLinks: [],
  };

  const failures = overrides.failures || {};
  // Which Connect accounts this fake believes exist. Anything not in here
  // raises `resource_missing`, which is exactly the state a farmer is in when
  // their stored account id has died — the case the recovery path handles.
  const accounts = new Map(
    (overrides.accounts || []).map((account) =>
      typeof account === 'string' ? [account, { id: account }] : [account.id, account],
    ),
  );
  let accountSeq = 0;

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
    accounts: {
      async create(params, options) {
        calls.accountsCreated.push({ params, options });
        if (failures.accountCreate) {
          throw stripeError(failures.accountCreate, 'account create failed');
        }
        accountSeq += 1;
        const account = {
          id: `acct_new_${accountSeq}`,
          charges_enabled: false,
          payouts_enabled: false,
          details_submitted: false,
          requirements: { currently_due: ['external_account'] },
          ...params,
        };
        accounts.set(account.id, account);
        return account;
      },
      async retrieve(id) {
        calls.accountsRetrieved.push(id);
        if (failures.accountRetrieve) {
          throw stripeError(failures.accountRetrieve, 'account retrieve failed');
        }
        const account = accounts.get(String(id));
        if (!account) {
          const error = stripeError('resource_missing', `No such account: ${id}`);
          error.statusCode = 404;
          throw error;
        }
        return {
          charges_enabled: false,
          payouts_enabled: false,
          details_submitted: false,
          requirements: { currently_due: [] },
          ...account,
        };
      },
      async createLoginLink(id) {
        calls.loginLinks.push(id);
        if (!accounts.has(String(id))) {
          const error = stripeError('resource_missing', `No such account: ${id}`);
          error.statusCode = 404;
          throw error;
        }
        return { url: `https://stripe.test/dashboard/${id}` };
      },
    },
    accountLinks: {
      async create(params) {
        calls.accountLinks.push(params);
        if (failures.accountLink) {
          throw stripeError(failures.accountLink, 'account link failed');
        }
        if (!accounts.has(String(params.account))) {
          const error = stripeError('resource_missing', `No such account: ${params.account}`);
          error.statusCode = 404;
          throw error;
        }
        return { url: `https://stripe.test/onboarding/${params.account}` };
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
