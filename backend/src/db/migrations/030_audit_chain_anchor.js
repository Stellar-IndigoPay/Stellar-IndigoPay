"use strict";

/**
 * Migration 030: audit_chain_anchor
 *
 * A singleton trust-point for the admin audit hash chain. When retention
 * (auditRetention.js) purges the oldest audit rows, it records the
 * `prev_hash` of the oldest surviving row here so that `verifyChain`
 * (auditChain.js) can resume verification from that anchor instead of
 * requiring the (now-deleted) genesis row.
 *
 * Columns:
 *   id            – fixed singleton key (always 1).
 *   anchor_hash   – the expected `prev_hash` of the oldest surviving row.
 *   anchor_row_id – id of the oldest surviving row (informational).
 *   anchored_at   – when the anchor was recorded.
 *   reason        – why the anchor was recorded (e.g. "retention").
 */

module.exports = {
  name: "030_audit_chain_anchor",

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_chain_anchor (
        id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        anchor_hash TEXT NOT NULL,
        anchor_row_id TEXT,
        anchored_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        reason TEXT NOT NULL DEFAULT 'retention'
      );
    `);
  },

  async down(client) {
    await client.query("DROP TABLE IF EXISTS audit_chain_anchor;");
  },
};
