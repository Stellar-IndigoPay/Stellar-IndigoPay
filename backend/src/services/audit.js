"use strict";

const { v4: uuid } = require("uuid");
const pool = require("../db/pool");
const { computeRowHash, getPrevHash } = require("./auditChain");

async function logAdminAction({
  actor,
  action,
  targetType,
  targetId,
  metadata,
  ipAddress,
}) {
  try {
    const id = uuid();
    const prevHash = await getPrevHash(pool).catch(() => "0");
    const metadataStr = JSON.stringify(metadata || {});

    // Compute the chain hash from the canonical fields. If the migration
    // (011_audit_chain) hasn't run yet the columns won't exist, so we fall
    // back to the original 7-column insert and skip hashing.
    let rowHash = null;
    try {
      rowHash = computeRowHash({
        id,
        actor,
        action,
        targetType: targetType || null,
        targetId: targetId || null,
        metadata: metadataStr,
        ipAddress: ipAddress || null,
        created_at: new Date(),
        prev_hash: prevHash,
      });
    } catch {
      rowHash = null;
    }

    if (rowHash) {
      await pool.query(
        `INSERT INTO admin_audit_log
           (id, actor, action, target_type, target_id, metadata, ip_address, prev_hash, row_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          id,
          actor,
          action,
          targetType || null,
          targetId || null,
          metadataStr,
          ipAddress || null,
          prevHash,
          rowHash,
        ],
      );
    } else {
      await pool.query(
        `INSERT INTO admin_audit_log (id, actor, action, target_type, target_id, metadata, ip_address)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          id,
          actor,
          action,
          targetType || null,
          targetId || null,
          metadataStr,
          ipAddress || null,
        ],
      );
    }
  } catch (err) {
    console.error("[AuditLog] Failed to record action:", err.message);
  }
}

function auditMiddleware(action, targetType) {
  return (req, res, next) => {
    const originalJson = res.json.bind(res);
    res.json = function (body) {
      if (res.statusCode < 400) {
        const actor =
          req.body?.adminAddress || req.body?.actor || req.ip || "unknown";
        const targetId = req.params?.id || req.body?.projectId || null;
        logAdminAction({
          actor,
          action,
          targetType,
          targetId,
          metadata: {
            method: req.method,
            path: req.originalUrl,
            statusCode: res.statusCode,
            body: sanitizeMetadata(req.body),
          },
          ipAddress: req.ip,
        });
      }
      return originalJson(body);
    };
    next();
  };
}

function sanitizeMetadata(body) {
  if (!body) return {};
  const sanitized = { ...body };
  delete sanitized.adminAddress;
  delete sanitized.secretKey;
  delete sanitized.secret;
  return sanitized;
}

module.exports = { logAdminAction, auditMiddleware };
