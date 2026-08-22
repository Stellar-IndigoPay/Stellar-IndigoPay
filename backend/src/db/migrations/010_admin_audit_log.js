"use strict";

/**
 * Base admin audit log schema. The hash-chain columns are added by
 * 011_audit_chain, while anchor metadata is added by 025_audit_anchors.
 */
module.exports = {
  name: "010_admin_audit_log",

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_audit_log (
        id UUID PRIMARY KEY,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        target_type TEXT,
        target_id TEXT,
        resource TEXT,
        metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
        ip_address TEXT,
        timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        anchor_index INTEGER
      )
    `);

    await client.query(
      "CREATE INDEX IF NOT EXISTS idx_admin_audit_log_created_at ON admin_audit_log (created_at, id)",
    );
  },

  async down(client) {
    await client.query("DROP TABLE IF EXISTS admin_audit_log");
  },
};
