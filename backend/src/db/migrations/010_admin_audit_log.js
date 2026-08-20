"use strict";

/**
 * 010_admin_audit_log
 *
 * Creates the admin audit log table that services/audit.js writes to and
 * migration 011 (audit_chain) extends with hash-chain columns.
 *
 * The table was previously created out-of-band (manual bootstrap), so a
 * database bootstrapped purely from migrations had no `admin_audit_log` and
 * migration 011 failed with "relation admin_audit_log does not exist".
 * Adding it here makes the migration chain self-sufficient — required for
 * replicas that boot against a fresh database (issue #640).
 *
 * Column set mirrors every consumer:
 *   - audit.js inserts id/actor/action/target_type/target_id/metadata/
 *     ip_address (+ prev_hash/row_hash once 011 has run)
 *   - auditAnchor.js reads resource/timestamp/anchor_index
 *   - audit-export.js filters metadata with the JSONB `->>` operator
 */
module.exports = {
  name: "010_admin_audit_log",

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_audit_log (
        id           UUID PRIMARY KEY,
        actor        TEXT        NOT NULL,
        action       TEXT        NOT NULL,
        target_type  TEXT,
        target_id    TEXT,
        metadata     JSONB,
        ip_address   TEXT,
        prev_hash    TEXT,
        row_hash     TEXT,
        anchor_index INTEGER,
        resource     TEXT,
        timestamp    BIGINT,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_admin_audit_log_created_at
        ON admin_audit_log (created_at DESC)
    `);
  },

  async down(client) {
    await client.query("DROP TABLE IF EXISTS admin_audit_log");
  },
};