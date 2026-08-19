// 030_bulk_ops.js - Migration to add the admin bulk-operation ledger.
"use strict";

/**
 * Migration 030: Bulk-operation ledger.
 * ---------------------------------------
 * Every admin bulk operation (backfills, deletions, exports, projection
 * recomputes, batch status changes) records a preview (intent, params hash,
 * filters, preview count/sample), requires explicit confirmation before it
 * executes, and lands a per-row outcome summary once it finishes.
 *
 * Lifecycle: preview -> confirmed -> completed|partial|failed
 *                     -> cancelled
 *                     -> expired (TTL elapsed without confirm/cancel)
 */
module.exports = {
  name: "030_bulk_ops",

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS bulk_ops (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        type TEXT NOT NULL,
        params JSONB NOT NULL,
        params_hash TEXT NOT NULL,
        filters JSONB,
        scope_ids JSONB NOT NULL DEFAULT '[]',
        preview_count INTEGER NOT NULL DEFAULT 0,
        sample JSONB,
        destructive BOOLEAN NOT NULL DEFAULT false,
        status TEXT NOT NULL DEFAULT 'preview',
        created_by TEXT NOT NULL,
        confirmed_by TEXT,
        outcomes JSONB,
        error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        started_at TIMESTAMPTZ,
        finished_at TIMESTAMPTZ,
        CONSTRAINT bulk_ops_status_check CHECK (
          status IN ('preview', 'confirmed', 'completed', 'partial', 'failed', 'cancelled', 'expired')
        )
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS bulk_ops_status_idx ON bulk_ops(status);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS bulk_ops_type_idx ON bulk_ops(type);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS bulk_ops_created_at_idx ON bulk_ops(created_at DESC);
    `);
  },

  async down(client) {
    await client.query(`DROP TABLE IF EXISTS bulk_ops;`);
  },
};
