// 025_audit_anchors.js - Migration to store on‑chain anchoring data for audit logs
"use strict";

/**
 * Migration 025: Audit Anchors
 * ---------------------------------------
 * This migration creates a new table `audit_anchors` that records each Merkle‑tree
 * root anchored to the Stellar blockchain. Storing the anchoring metadata
 * enables verification of the tamper‑evident audit trail without re‑processing the
 * entire audit log.
 *
 * Columns:
 *   id               – Primary key (auto‑increment integer).
 *   anchored_at      – Timestamp when the anchor was submitted on‑chain.
 *   merkle_root      – Hex‑encoded SHA‑256 Merkle root of the batch of audit entries.
 *   transaction_hash – Soroban transaction hash (hex) of the contract call that
 *                      performed the anchoring. Allows external verification.
 *   batch_start_id   – The `id` of the first audit log entry included in the batch.
 *   batch_end_id     – The `id` of the last audit log entry included in the batch.
 */
module.exports = {
  name: "025_audit_anchors",

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_anchors (
        id SERIAL PRIMARY KEY,
        anchored_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        merkle_root TEXT NOT NULL,
        transaction_hash TEXT NOT NULL,
        batch_start_id INTEGER NOT NULL,
        batch_end_id INTEGER NOT NULL,
        CONSTRAINT batch_ids_check CHECK (batch_start_id <= batch_end_id)
      );
    `);
  },

  async down(client) {
    await client.query(`DROP TABLE IF EXISTS audit_anchors;`);
  }
};
