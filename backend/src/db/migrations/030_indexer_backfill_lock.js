/**
 * 030_indexer_backfill_lock
 *
 * Idempotency guard for the backfill/reconciliation pipeline.
 *
 * Problem:
 *   indexerBackfill.js and indexerReconciler.js can run concurrently —
 *   either two replicas starting up at the same time, or an admin-triggered
 *   manual backfill overlapping with the periodic reconciler cron. The old
 *   application-level `backfill_in_progress` flag is a *soft* check: both
 *   replicas can read `false` before either writes `true`, forming a TOCTOU
 *   window that allows double-inserts.
 *
 * Solution:
 *   1. A Postgres advisory lock (numeric key derived from the constant
 *      "indigopay_indexer_backfill") serialises all backfill/reconcile calls
 *      across replicas. Only one call holds the lock at a time; others
 *      abort immediately via pg_try_advisory_lock and return `skipped: true`.
 *
 *   2. This migration adds a unique partial index on `donation_events`
 *      keyed on (transaction_hash, indexer_operation_id) so that even if
 *      the advisory-lock guard is somehow bypassed, a duplicate insert is
 *      rejected by the database rather than silently stored.
 *
 * Phase: expand — only adds a new index and a row to indexer_state.
 *        Fully backward-compatible; no column is dropped or renamed.
 */
"use strict";

module.exports = {
  name: "030_indexer_backfill_lock",
  phase: "expand",

  async up(client) {
    // Unique index on donation_events ensures that even if two concurrent
    // backfill/reconcile paths race past the advisory lock, the second
    // INSERT is rejected by the database constraint rather than creating a
    // duplicate row.  The partial filter (`WHERE indexer_operation_id IS
    // NOT NULL`) mirrors the idempotency index on the `donations` table
    // introduced in migration 028.
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_donation_events_tx_op_id
      ON donation_events (transaction_hash, indexer_operation_id)
      WHERE indexer_operation_id IS NOT NULL
    `);

    // Unique partial index for events without an operation ID (non-indexer
    // writers — e.g. REST-submitted donations — deduplicated by hash alone).
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_donation_events_tx_no_op_id
      ON donation_events (transaction_hash)
      WHERE indexer_operation_id IS NULL
    `);

    // Ensure the indexer_state row has the new advisory-lock tracking column
    // that the application code will use to log when it skipped due to the lock.
    // Column is nullable so existing rows are unaffected (no default needed).
    await client.query(`
      ALTER TABLE indexer_state
      ADD COLUMN IF NOT EXISTS last_lock_skipped_at TIMESTAMPTZ
    `);
  },

  async down(client) {
    await client.query(
      "DROP INDEX IF EXISTS uq_donation_events_tx_op_id",
    );
    await client.query(
      "DROP INDEX IF EXISTS uq_donation_events_tx_no_op_id",
    );
    await client.query(`
      ALTER TABLE indexer_state
      DROP COLUMN IF EXISTS last_lock_skipped_at
    `);
  },
};
