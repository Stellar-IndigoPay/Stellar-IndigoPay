"use strict";

/**
 * Migration: 006_attestation_backfill_state
 *
 * Adds the singleton cursor table used by the attestation back-fill
 * worker (see `services/attestationBackfillQueue.js`). One row keyed
 * by `id = 'attestation_events'` tracks `last_ledger` so a restart of
 * the worker can resume exactly where it left off without re-processing
 * or skipping events.
 *
 * The schema also stores `last_run_at` and `last_status` for visibility
 * in `/api/admin/audit-log` surfaces and Prometheus alerting (when wired
 * up — the worker increments a counter exposed at /metrics).
 */
module.exports = {
  name: "006_attestation_backfill_state",

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS attestation_backfill_state (
        id              VARCHAR(64) PRIMARY KEY,
        last_ledger     BIGINT NOT NULL DEFAULT 0,
        last_run_at     TIMESTAMPTZ,
        last_status     TEXT,
        last_error      TEXT,
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Idempotent bootstrap row so the worker can read the cursor without
    // checking for existence on every poll.
    await client.query(
      `INSERT INTO attestation_backfill_state (id, last_ledger)
       VALUES ('attestation_events', 0)
       ON CONFLICT (id) DO NOTHING`,
    );
  },

  async down(client) {
    await client.query(`DROP TABLE IF EXISTS attestation_backfill_state`);
  },
};
