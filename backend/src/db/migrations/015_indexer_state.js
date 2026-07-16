/**
 * 015_indexer_state.js
 *
 * Persistent indexer cursor tracking, reconciliation, and dead-letter queue.
 *
 * - indexer_state: persists the last-processed ledger cursor so the indexer
 *   resumes from where it left off after a restart, preventing donation loss.
 * - indexer_dlq: captures failed donation processing attempts with retry
 *   tracking, enabling automatic recovery without manual intervention.
 */
"use strict";

module.exports = {
  name: "015_indexer_state",

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS indexer_state (
        key            TEXT PRIMARY KEY,
        last_processed_ledger INTEGER NOT NULL,
        last_processed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        backfill_in_progress  BOOLEAN NOT NULL DEFAULT false,
        backfill_target_ledger INTEGER,
        reconciled_at         TIMESTAMPTZ
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS indexer_dlq (
        id              SERIAL PRIMARY KEY,
        ledger          INTEGER NOT NULL,
        transaction_hash TEXT NOT NULL,
        error_message   TEXT NOT NULL,
        retry_count     INTEGER NOT NULL DEFAULT 0,
        max_retries     INTEGER NOT NULL DEFAULT 5,
        next_retry_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        resolved_at     TIMESTAMPTZ,
        UNIQUE(transaction_hash)
      )
    `);

    // Index for DLQ retry polling — fetch entries whose next_retry_at has
    // passed and that haven't exceeded max_retries.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_indexer_dlq_next_retry
      ON indexer_dlq (next_retry_at ASC)
      WHERE resolved_at IS NULL AND retry_count < max_retries
    `);

    // Seed the initial cursor state row.
    await client.query(`
      INSERT INTO indexer_state (key, last_processed_ledger)
      VALUES ('primary', 0)
      ON CONFLICT (key) DO NOTHING
    `);
  },

  async down(client) {
    await client.query(`DROP INDEX IF EXISTS idx_indexer_dlq_next_retry`);
    await client.query(`DROP TABLE IF EXISTS indexer_dlq`);
    await client.query(`DROP TABLE IF EXISTS indexer_state`);
  },
};
