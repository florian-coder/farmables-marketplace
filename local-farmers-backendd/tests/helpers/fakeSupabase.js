// Supabase fals, în memorie, cât să acopere tiparele de interogare folosite de
// rute. Scopul e ca testele de securitate să treacă prin codul real de rute și
// middleware, nu prin mock-uri de nivel înalt care ar ascunde tocmai bug-ul.

const crypto = require('crypto');

const clone = (value) => JSON.parse(JSON.stringify(value));

/** Tabele cu cheie unică, ca să putem simula eroarea 23505. */
const UNIQUE_KEYS = {
  stripe_events: ['id'],
  auth_tokens: ['token_hash'],
  users: ['username'],
  // Cheia unică pe `order_id` E mecanismul de idempotență al transferurilor.
  order_transfers: ['order_id'],
  // Idem pentru notificări: `event_key` e derivat din faptul petrecut, deci o
  // reluare de webhook se pliază peste rândul deja existent.
  email_outbox: ['event_key'],
};

/**
 * Indexuri unice parțiale: perechea (coloane, predicat). `refunds` are unul
 * singur — o comandă se rambursează integral cel mult o dată — și fără el
 * testul de idempotență ar trece degeaba.
 */
const PARTIAL_UNIQUE_KEYS = {
  refunds: [
    {
      columns: ['order_id'],
      where: (row) => row.kind === 'full' && row.state !== 'failed',
    },
  ],
};

const matchesFilters = (row, filters) =>
  filters.every((filter) => {
    const actual = row[filter.column];
    if (filter.type === 'eq') return String(actual) === String(filter.value);
    if (filter.type === 'neq') return String(actual) !== String(filter.value);
    if (filter.type === 'in') return filter.value.map(String).includes(String(actual));
    if (filter.type === 'gte') return String(actual) >= String(filter.value);
    if (filter.type === 'gt') return String(actual) > String(filter.value);
    if (filter.type === 'lte') return String(actual) <= String(filter.value);
    if (filter.type === 'lt') return String(actual) < String(filter.value);
    if (filter.type === 'is') return actual === filter.value;
    if (filter.type === 'not') {
      // Doar forma `not(column, 'is', null)`, singura folosită de rute.
      if (filter.operator === 'is') return actual !== filter.value;
      return String(actual) !== String(filter.value);
    }
    // `or('a.eq.1,b.eq.2')` — PostgREST syntax, only the eq form is used.
    if (filter.type === 'or') {
      return filter.value
        .split(',')
        .some((clause) => {
          const [column, op, value] = clause.split('.');
          return op === 'eq' && String(row[column]) === String(value);
        });
    }
    return true;
  });

/**
 * @param initial  rânduri de pornire, per tabelă
 * @param options.rpc  handlere pentru funcțiile SQL, `name -> (args, db) => data`.
 *                     Fără handler, `rpc` întoarce `{ success: true }` ca înainte.
 */
const createFakeSupabase = (initial = {}, options = {}) => {
  const rpcHandlers = options.rpc || {};
  const db = {};
  for (const [table, rows] of Object.entries(initial)) {
    db[table] = clone(rows);
  }
  const tableOf = (name) => {
    if (!db[name]) db[name] = [];
    return db[name];
  };

  const calls = { rpc: [], signedUrls: [], uploads: [] };

  const duplicateError = () => ({
    code: '23505',
    message: 'duplicate key value violates unique constraint',
  });

  const violatesUnique = (table, row) => {
    const keys = UNIQUE_KEYS[table];
    if (
      keys &&
      tableOf(table).some((existing) =>
        keys.every((key) => existing[key] !== undefined && existing[key] === row[key]),
      )
    ) {
      return true;
    }

    for (const index of PARTIAL_UNIQUE_KEYS[table] || []) {
      if (!index.where(row)) continue;
      const clash = tableOf(table).some(
        (existing) =>
          index.where(existing) &&
          index.columns.every(
            (key) => existing[key] !== undefined && String(existing[key]) === String(row[key]),
          ),
      );
      if (clash) return true;
    }

    return false;
  };

  const makeBuilder = (table) => {
    const state = {
      op: 'select',
      filters: [],
      payload: null,
      orderBy: [],
      limit: null,
      returning: false,
    };

    const applyOrder = (rows) => {
      let result = rows;
      for (const { column, ascending } of [...state.orderBy].reverse()) {
        result = [...result].sort((a, b) => {
          const left = a[column] ?? '';
          const right = b[column] ?? '';
          if (left === right) return 0;
          return (left < right ? -1 : 1) * (ascending ? 1 : -1);
        });
      }
      return result;
    };

    const run = () => {
      const rows = tableOf(table);

      if (state.op === 'select') {
        let matched = rows.filter((row) => matchesFilters(row, state.filters));
        matched = applyOrder(matched);
        if (state.limit !== null) matched = matched.slice(0, state.limit);
        return { data: clone(matched), error: null, count: matched.length };
      }

      if (state.op === 'insert') {
        const incoming = Array.isArray(state.payload) ? state.payload : [state.payload];
        const inserted = [];
        for (const entry of incoming) {
          const row = { id: crypto.randomUUID(), ...clone(entry) };
          if (violatesUnique(table, row)) {
            return { data: null, error: duplicateError() };
          }
          rows.push(row);
          inserted.push(row);
        }
        return { data: clone(inserted), error: null };
      }

      if (state.op === 'update') {
        const updated = [];
        for (const row of rows) {
          if (!matchesFilters(row, state.filters)) continue;
          Object.assign(row, clone(state.payload));
          updated.push(row);
        }
        return { data: clone(updated), error: null };
      }

      if (state.op === 'upsert') {
        const entry = clone(state.payload);
        const conflictKey = state.conflictColumn || 'id';
        const existing = rows.find(
          (row) => String(row[conflictKey]) === String(entry[conflictKey]),
        );
        if (existing) {
          Object.assign(existing, entry);
          return { data: clone([existing]), error: null };
        }
        const row = { id: crypto.randomUUID(), ...entry };
        rows.push(row);
        return { data: clone([row]), error: null };
      }

      if (state.op === 'delete') {
        const removed = [];
        for (let index = rows.length - 1; index >= 0; index -= 1) {
          if (matchesFilters(rows[index], state.filters)) {
            removed.push(rows[index]);
            rows.splice(index, 1);
          }
        }
        return { data: clone(removed), error: null };
      }

      return { data: null, error: { message: 'unsupported operation' } };
    };

    const builder = {
      select(_columns) {
        if (state.op === 'select') state.op = 'select';
        state.returning = true;
        return builder;
      },
      insert(payload) {
        state.op = 'insert';
        state.payload = payload;
        return builder;
      },
      update(payload) {
        state.op = 'update';
        state.payload = payload;
        return builder;
      },
      upsert(payload, options = {}) {
        state.op = 'upsert';
        state.payload = payload;
        state.conflictColumn = options.onConflict || 'id';
        return builder;
      },
      delete() {
        state.op = 'delete';
        return builder;
      },
      eq(column, value) {
        state.filters.push({ type: 'eq', column, value });
        return builder;
      },
      neq(column, value) {
        state.filters.push({ type: 'neq', column, value });
        return builder;
      },
      in(column, value) {
        state.filters.push({ type: 'in', column, value });
        return builder;
      },
      gte(column, value) {
        state.filters.push({ type: 'gte', column, value });
        return builder;
      },
      gt(column, value) {
        state.filters.push({ type: 'gt', column, value });
        return builder;
      },
      lte(column, value) {
        state.filters.push({ type: 'lte', column, value });
        return builder;
      },
      lt(column, value) {
        state.filters.push({ type: 'lt', column, value });
        return builder;
      },
      is(column, value) {
        state.filters.push({ type: 'is', column, value });
        return builder;
      },
      not(column, operator, value) {
        state.filters.push({ type: 'not', column, operator, value });
        return builder;
      },
      or(expression) {
        state.filters.push({ type: 'or', value: String(expression) });
        return builder;
      },
      order(column, options = {}) {
        state.orderBy.push({ column, ascending: options.ascending !== false });
        return builder;
      },
      limit(count) {
        state.limit = count;
        return builder;
      },
      maybeSingle() {
        const result = run();
        if (result.error) return Promise.resolve(result);
        return Promise.resolve({ data: result.data?.[0] ?? null, error: null });
      },
      single() {
        const result = run();
        if (result.error) return Promise.resolve(result);
        const row = result.data?.[0];
        if (!row) {
          return Promise.resolve({ data: null, error: { message: 'no rows returned' } });
        }
        return Promise.resolve({ data: row, error: null });
      },
      then(resolve, reject) {
        return Promise.resolve(run()).then(resolve, reject);
      },
    };

    return builder;
  };

  const storageBucket = (bucket) => ({
    async upload(path, _buffer, _options) {
      calls.uploads.push({ bucket, path });
      return { data: { path }, error: null };
    },
    getPublicUrl(path) {
      return { data: { publicUrl: `https://example.test/storage/v1/object/public/${bucket}/${path}` } };
    },
    async createSignedUrl(path, expiresIn) {
      calls.signedUrls.push({ bucket, path, expiresIn });
      return {
        data: { signedUrl: `https://example.test/signed/${bucket}/${path}?exp=${expiresIn}` },
        error: null,
      };
    },
  });

  return {
    from: (table) => makeBuilder(table),
    rpc: async (name, args) => {
      calls.rpc.push({ name, args });
      const handler = rpcHandlers[name];
      if (typeof handler === 'function') {
        const result = await handler(args, db);
        // Un handler poate întoarce direct datele sau perechea {data,error}.
        if (result && typeof result === 'object' && ('data' in result || 'error' in result)) {
          return { data: result.data ?? null, error: result.error ?? null };
        }
        return { data: result ?? null, error: null };
      }
      return { data: { success: true }, error: null };
    },
    storage: { from: storageBucket },
    _db: db,
    _calls: calls,
  };
};

module.exports = { createFakeSupabase };
