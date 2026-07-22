// backend/src/services/auditAnchor.js
"use strict";

const pool = require("../db/pool");
const { buildMerkleTree } = require("./merkleTree");
const stellar = require("./stellar");
const { Counter } = require("prom-client");
const { registry } = require("./metrics");

// Prometheus metrics for anchoring success/failure
const auditAnchorSuccessTotal = new Counter({
  name: "indigopay_audit_anchor_success_total",
  help: "Successful audit anchoring operations",
  registers: [registry],
});

const auditAnchorFailureTotal = new Counter({
  name: "indigopay_audit_anchor_failure_total",
  help: "Failed audit anchoring operations",
  registers: [registry],
});

/**
 * Run a single anchoring cycle.
 *   1. Fetch up to 1000 unanchored audit entries (anchor_index IS NULL).
 *   2. Build a Merkle tree from the entries.
 *   3. Submit the root to Soroban via stellar.anchorAuditRoot.
 *   4. Record the anchor in the audit_anchors table and update entries with anchor_index.
 */
async function runAnchoringJob() {
  const client = await pool.connect();
  try {
    // 1. Fetch unanchored entries ordered by created_at.
    const res = await client.query(
      `SELECT id, prev_hash, action, actor, resource, timestamp FROM admin_audit_log WHERE anchor_index IS NULL ORDER BY created_at ASC LIMIT 1000`
    );
    if (res.rowCount === 0) {
      return; // Nothing to anchor.
    }
    const entries = res.rows.map((row) => ({
      id: row.id,
      prevHash: row.prev_hash,
      action: row.action,
      actor: row.actor,
      resource: row.resource,
      timestamp: row.timestamp,
    }));

    // 2. Build Merkle tree.
    const { root, tree } = buildMerkleTree(entries);
    const merkleRootHex = root.toString("hex");
    const anchorIndexRes = await client.query(`SELECT COALESCE(MAX(anchor_index), 0) + 1 AS next_index FROM audit_anchors`);
    const anchorIndex = anchorIndexRes.rows[0].next_index;
    const timestamp = Math.floor(Date.now() / 1000);

    // 3. Submit root on-chain.
    const transactionHash = await stellar.anchorAuditRoot(anchorIndex, merkleRootHex, timestamp);

    // 4. Persist anchor data.
    await client.query(
      `INSERT INTO audit_anchors (anchor_index, merkle_root, entry_count, first_entry_id, last_entry_id, transaction_hash, anchored_at) VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [
        anchorIndex,
        merkleRootHex,
        entries.length,
        entries[0].id,
        entries[entries.length - 1].id,
        transactionHash,
      ]
    );

    // Update audit entries with anchor_index.
    const ids = entries.map((e) => e.id);
    await client.query(`UPDATE admin_audit_log SET anchor_index = $1 WHERE id = ANY($2)`, [anchorIndex, ids]);

    auditAnchorSuccessTotal.inc();
  } catch (err) {
    console.error("[AuditAnchor] Failed anchoring cycle:", err);
    auditAnchorFailureTotal.inc();
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { runAnchoringJob };
