/**
 * 028_soroban_event_dlq.js
 *
 * Dead-letter queue for Soroban event processing with exponential-backoff
 * retries and a terminal poison-message quarantine.
 *
 * The `soroban_event_dlq` base table is created by the earlier
 * `028_soroban_event_dedup` migration (runs first, lexically). This migration
 * extends it with the retry/quarantine lifecycle columns:
 *
 *   - `retry_count` / `max_retries` track the retry ladder; entries that
 *     exhaust their budget move to the terminal `quarantined` state so a
 *     permanently malformed ("poison") event stops consuming pipeline
 *     capacity, is observable via the quarantine metric, and never gets
 *     re-processed.
 *
 *   - `next_attempt_at` schedules the next backoff attempt; a partial index
 *     keeps the retry poll cheap.
 *
 *   - A partial UNIQUE index on `paging_token` guarantees at most one live
 *     (pending/retrying) entry per event — the dedup backstop that prevents
 *     the same failed event from accumulating duplicate DLQ rows, which also
 *     makes the write path idempotent via `ON CONFLICT`.
 *
 * All statements are idempotent (`IF NOT EXISTS`) so the migration is safe on
 * a fresh database as well as one where the dedup migration already created
 * the base table.
 */
"use strict";

module.exports = {
  name: "028_soroban_event_dlq",

  async up(client) {
    // Fallback: create the base table if this migration runs on a database
    // that predates `028_soroban_event_dedup`. Matches that schema exactly;
    // when the table already exists this is a no-op.
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
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        retry_count      INTEGER NOT NULL DEFAULT 0,
        max_retries      INTEGER NOT NULL DEFAULT 3,
        next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        status           TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'retrying', 'resolved', 'quarantined')),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        resolved_at      TIMESTAMPTZ,
        quarantined_at   TIMESTAMPTZ
      )
    `);

    // ── Retry/quarantine lifecycle columns ────────────────────────────────────
    // All `NOT NULL` columns carry defaults (expand-contract safe) and every
    // statement is idempotent against the table created by the dedup migration.
    await client.query(`
      ALTER TABLE soroban_event_dlq
        ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0
    `);
    await client.query(`
      ALTER TABLE soroban_event_dlq
        ADD COLUMN IF NOT EXISTS max_retries INTEGER NOT NULL DEFAULT 3
    `);
    await client.query(`
      ALTER TABLE soroban_event_dlq
        ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    `);
    await client.query(`
      ALTER TABLE soroban_event_dlq
        ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'retrying', 'resolved', 'quarantined'))
    `);
    await client.query(`
      ALTER TABLE soroban_event_dlq
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    `);
    await client.query(`
      ALTER TABLE soroban_event_dlq
        ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ
    `);
    await client.query(`
      ALTER TABLE soroban_event_dlq
        ADD COLUMN IF NOT EXISTS quarantined_at TIMESTAMPTZ
    `);

    // Dedup backstop: at most one live entry per event. Mirrors the
    // `ON CONFLICT (paging_token) WHERE status IN ('pending', 'retrying')`
    // predicate used by the write path.
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_soroban_event_dlq_active_paging_token
      ON soroban_event_dlq (paging_token)
      WHERE status IN ('pending', 'retrying')
    `);

    // Retry-poll index — fetch entries whose backoff window has elapsed and
    // that haven't exhausted their retry budget.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_soroban_event_dlq_next_attempt
      ON soroban_event_dlq (next_attempt_at ASC)
      WHERE status IN ('pending', 'retrying') AND retry_count < max_retries
    `);
  },

  async down(client) {
    await client.query("DROP INDEX IF EXISTS idx_soroban_event_dlq_next_attempt");
    await client.query("DROP INDEX IF EXISTS uq_soroban_event_dlq_active_paging_token");
    await client.query(`
      ALTER TABLE soroban_event_dlq
        DROP COLUMN IF EXISTS quarantined_at,
        DROP COLUMN IF EXISTS resolved_at,
        DROP COLUMN IF EXISTS updated_at,
        DROP COLUMN IF EXISTS status,
        DROP COLUMN IF EXISTS next_attempt_at,
        DROP COLUMN IF EXISTS max_retries,
        DROP COLUMN IF EXISTS retry_count
    `);
  },
};
