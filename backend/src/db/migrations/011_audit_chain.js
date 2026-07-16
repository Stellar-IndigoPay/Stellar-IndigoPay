"use strict";

/**
 * Migration 011: Audit log hash-chain columns.
 *
 * Adds `prev_hash` (SHA-256 of the previous row's row_hash) and `row_hash`
 * (SHA-256 over the row's own fields) to `admin_audit_log`. Together these
 * form a tamper-evident hash chain: mutating any historical row invalidates
 * its row_hash AND every subsequent row's prev_hash, which `verifyChain`
 * (src/services/auditChain.js) detects.
 *
 * `up()` is idempotent (ADD COLUMN IF NOT EXISTS) so re-running migrations is
 * safe. `down()` removes both columns.
 */

module.exports = {
  name: "011_audit_chain",

  async up(client) {
    await client.query(
      "ALTER TABLE admin_audit_log ADD COLUMN IF NOT EXISTS prev_hash TEXT",
    );
    await client.query(
      "ALTER TABLE admin_audit_log ADD COLUMN IF NOT EXISTS row_hash TEXT",
    );

    // Backfill row_hash for any pre-existing rows so verifyChain can validate
    // them. We recompute each row from its own stored fields. Rows that have
    // no following row can have prev_hash left NULL/empty; verifyChain treats
    // the genesis row's prev_hash as '0' when empty. We set prev_hash to '0'
    // for the oldest row and chain forward by created_at.
    await client.query(`
      WITH ordered AS (
        SELECT
          id,
          actor,
          action,
          target_type,
          target_id,
          metadata,
          ip_address,
          created_at,
          LAG(row_hash) OVER (ORDER BY created_at ASC, id ASC) AS computed_prev_hash
        FROM (
          SELECT
            id,
            actor,
            action,
            target_type,
            target_id,
            metadata,
            ip_address,
            created_at,
            encode(
              digest(
                COALESCE(id, '') || '|' ||
                COALESCE(actor, '') || '|' ||
                COALESCE(action, '') || '|' ||
                COALESCE(target_type, '') || '|' ||
                COALESCE(target_id, '') || '|' ||
                COALESCE(metadata, '') || '|' ||
                COALESCE(ip_address, '') || '|' ||
                COALESCE(created_at::text, '') || '|' ||
                COALESCE(LAG(row_hash) OVER (ORDER BY created_at ASC, id ASC), '0'),
                'sha256'
              ),
              'hex'
            ) AS row_hash
          FROM admin_audit_log
          ORDER BY created_at ASC, id ASC
        ) sub
        ORDER BY created_at ASC, id ASC
      )
      UPDATE admin_audit_log a
      SET row_hash = ordered.row_hash,
          prev_hash = COALESCE(ordered.computed_prev_hash, '0')
      FROM ordered
      WHERE a.id = ordered.id
    `);
  },

  async down(client) {
    await client.query(
      "ALTER TABLE admin_audit_log DROP COLUMN IF NOT EXISTS row_hash",
    );
    await client.query(
      "ALTER TABLE admin_audit_log DROP COLUMN IF NOT EXISTS prev_hash",
    );
  },
};
