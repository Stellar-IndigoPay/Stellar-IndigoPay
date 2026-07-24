"use strict";

/**
 * In-memory fake `pg.Pool` used by the projectionEngine unit tests.
 *
 * It does NOT execute arbitrary SQL. It records every query (text + params)
 * so the unit tests can assert on the *statements* the engine issues — which
 * handler ran, that upserts are idempotent (ON CONFLICT), the correct columns
 * are touched, and that rebuild replays every event.
 *
 * To support rebuild-correctness assertions without a real database, the fake
 * implements a tiny, purpose-built interpreter for the `donation_events` event
 * store only:
 *   - INSERT INTO donation_events … RETURNING id, created_at  → persists a row
 *   - SELECT … FROM donation_events ORDER BY id ASC          → returns stored rows
 * Every other statement is recorded and returns an empty result. Data-level
 * correctness (totals, donor_count derivation, rebuild == incremental) is
 * covered by projectionEngine.integration.test.js against real Postgres.
 *
 * `connect()` returns a client that proxies `query` and is `release()`-able,
 * so the engine's transaction wrapper (BEGIN/COMMIT/ROLLBACK) is a no-op here.
 */

const recorded = [];
let eventSeq = 0;
let eventRows = [];

function makeClient() {
  return {
    query(text, params) {
      return fakePool.query(text, params);
    },
    release() {},
  };
}

const fakePool = {
  query(text, params) {
    const p = params || [];
    recorded.push({ text, params: p });

    if (/INSERT INTO donation_events/.test(text) && /RETURNING id/.test(text)) {
      // params: [event_type, aggregate_id, event_data_json, ledger, tx_hash]
      eventSeq += 1;
      const row = {
        id: eventSeq,
        event_type: p[0],
        aggregate_id: p[1],
        event_data: p[2],
        soroban_ledger: p[3],
        transaction_hash: p[4],
        created_at: new Date(),
      };
      eventRows.push(row);
      return Promise.resolve({ rows: [row] });
    }

    if (/FROM donation_events/.test(text) && /ORDER BY id ASC/.test(text)) {
      return Promise.resolve({ rows: eventRows.slice().sort((a, b) => a.id - b.id) });
    }

    return Promise.resolve({ rows: [] });
  },
  connect() {
    return Promise.resolve(makeClient());
  },
  __reset() {
    recorded.length = 0;
    eventSeq = 0;
    eventRows = [];
  },
  __resetCalls() {
    recorded.length = 0;
  },
  __calls() {
    return recorded;
  },
  __eventRows() {
    return eventRows;
  },
};

module.exports = fakePool;
