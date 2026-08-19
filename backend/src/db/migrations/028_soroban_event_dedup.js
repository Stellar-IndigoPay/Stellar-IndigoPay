"use strict";

/**
 * 028_soroban_event_dedup
 *
 * Adds durable deduplication for Soroban event processing.
 *
 * Problem: sorobanEventService.js previously used an in-memory Set to track
 * processed events by pagingToken, and persisted the cursor separately. A
 * crash between event processing and cursor commit would cause re-processing
 * of events (the in-memory set is lost on restart), leading to double-applied
 * projections.
 *
 * Solution: Add a `soroban_processed_events` table with a unique constraint
 * on pagingToken. The service now uses this table for durable deduplication.
 * Cursor advancement and event tracking are wrapped in a single DB transaction,
 * making re-processing idempotent.
 *
 * The table stores minimal metadata (pagingToken, eventType, ledger) and
 * implements automatic cleanup of events older than 30 days to prevent
 * unbounded growth while maintaining a rolling dedup window far exceeding
 * any realistic replay scenario.
 */

module.exports = {
  name: "028_soroban_event_dedup",

  async up(client) {
    // ── Processed events table for durable dedup ──────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS soroban_processed_events (
        paging_token     TEXT PRIMARY KEY,
        event_type       VARCHAR(50) NOT NULL,
        ledger_sequence  INTEGER NOT NULL,
        transaction_hash TEXT,
        processed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // Index for cleanup queries (DELETE WHERE processed_at < NOW() - INTERVAL '30 days')
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_soroban_processed_events_cleanup
        ON soroban_processed_events (processed_at)
    `);

    // Index for efficient lookups by ledger sequence
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_soroban_processed_events_ledger
        ON soroban_processed_events (ledger_sequence DESC)
    `);

    // ── Dead-letter queue for failed events ───────────────────────────────────
    // Events that fail processing after retry are written here with error details
    // for manual investigation and replay.
    await client.query(`
      CREATE TABLE IF NOT EXISTS soroban_event_dlq (
        id               BIGSERIAL PRIMARY KEY,
        event_type       VARCHAR(50) NOT NULL,
        contract_id      TEXT NOT NULL,
        paging_token     TEXT,
        event_data       JSONB NOT NULL,
        error_message    TEXT NOT NULL,
        error_stack      TEXT,
        attempt_count    INTEGER NOT NULL DEFAULT 1,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_soroban_event_dlq_created
        ON soroban_event_dlq (created_at DESC)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_soroban_event_dlq_event_type
        ON soroban_event_dlq (event_type)
    `);
  },

  async down(client) {
    await client.query("DROP TABLE IF EXISTS soroban_event_dlq");
    await client.query("DROP TABLE IF EXISTS soroban_processed_events");
  },
};
