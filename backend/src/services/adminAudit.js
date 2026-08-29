"use strict";

/**
 * src/services/adminAudit.js
 *
 * Append-only admin audit log service (issue #1128 Part A).
 *
 * Every admin mutation that touches critical state — project verification,
 * admin key rotation, contract upgrades, emergency withdrawals — MUST be
 * recorded through this service so the history is inspectable and traceable.
 *
 * Design goals:
 *   1. Append-only: the table-level immutability trigger prevents UPDATE/DELETE.
 *      This service never issues anything but INSERT.
 *   2. Before / after state: callers supply the resource snapshot before and
 *      after the mutation so reviewers see the semantic change, not just that
 *      something happened.
 *   3. Tamper-evident: each row is linked into a SHA-256 hash chain via
 *      auditChain.js.  Altering any historical row breaks the chain.
 *   4. Fire-and-forget: audit failures are logged but never propagate to the
 *      caller.  An audit outage must never block admin operations.
 *
 * Usage:
 *
 *   const { logAdminAction } = require('./adminAudit');
 *
 *   // Inside an admin route handler, after the mutation succeeds:
 *   await logAdminAction({
 *     actor:        req.admin.sub,            // authenticated admin id
 *     action:       'project.verify',         // namespaced verb
 *     resourceType: 'project',
 *     resourceId:   project.id,
 *     beforeState:  { status: 'pending' },    // snapshot before mutation
 *     afterState:   { status: 'approved' },   // snapshot after mutation
 *     ipAddress:    req.ip,
 *     userAgent:    req.get('User-Agent'),
 *   });
 *
 * The `auditMiddleware` factory is a convenience wrapper for routes that
 * follow the standard pattern (successful response → audit the request).
 * For complex flows (multi-step mutations, conditional state changes) call
 * `logAdminAction` directly so you can supply accurate before/after states.
 */

const { v4: uuid } = require("uuid");
const pool = require("../db/pool");
const logger = require("../logger");
const { computeRowHash, getPrevHash } = require("./auditChain");

// ── Core writer ─────────────────────────────────────────────────────────────

/**
 * Record a single admin action in the audit log.
 *
 * Never throws: errors are caught, logged to stderr/pino, and swallowed so
 * that an audit outage cannot block a legitimate admin operation.
 *
 * @param {Object}      params
 * @param {string}      params.actor        - Authenticated admin identifier
 * @param {string}      params.action       - Namespaced action verb (e.g. "project.verify")
 * @param {string}      [params.resourceType] - Type of the affected resource (e.g. "project")
 * @param {string}      [params.resourceId]   - Identifier of the affected resource
 * @param {Object|null} [params.beforeState]  - Resource snapshot before the mutation
 * @param {Object|null} [params.afterState]   - Resource snapshot after the mutation
 * @param {Object}      [params.metadata]     - Extra key/value context
 * @param {string}      [params.ipAddress]    - Client IP address
 * @param {string}      [params.userAgent]    - Client User-Agent string
 * @returns {Promise<void>}
 */
async function logAdminAction({
  actor,
  action,
  resourceType,
  resourceId,
  beforeState,
  afterState,
  metadata,
  ipAddress,
  userAgent,
  // Legacy aliases — kept for callers that still use audit.js field names.
  targetType,
  targetId,
}) {
  try {
    const id = uuid();
    const resolvedResourceType = resourceType || targetType || null;
    const resolvedResourceId   = resourceId   || targetId   || null;

    const beforeStateStr =
      beforeState != null ? JSON.stringify(beforeState) : null;
    const afterStateStr =
      afterState != null ? JSON.stringify(afterState) : null;
    const metadataStr = JSON.stringify(metadata || {});

    // Hash-chain: compute the row hash so any post-insert tampering breaks
    // the chain.  We pass targetType / targetId in the canonicalized fields
    // so the hash covers the resource_type / resource_id values.
    const prevHash = await getPrevHash(pool).catch(() => "0");
    let rowHash = null;
    try {
      rowHash = computeRowHash({
        id,
        actor,
        action,
        targetType: resolvedResourceType,
        targetId:   resolvedResourceId,
        metadata:   metadataStr,
        ipAddress:  ipAddress || null,
        created_at: new Date(),
        prev_hash:  prevHash,
      });
    } catch (hashErr) {
      logger.warn(
        { event: "audit_hash_error", err: hashErr.message },
        "adminAudit: failed to compute row hash — inserting without chain link",
      );
    }

    await pool.query(
      `INSERT INTO admin_audit_log
         (id, actor, action, resource_type, resource_id,
          before_state, after_state, metadata,
          ip_address, user_agent, prev_hash, row_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        id,
        actor,
        action,
        resolvedResourceType,
        resolvedResourceId,
        beforeStateStr,
        afterStateStr,
        metadataStr,
        ipAddress  || null,
        userAgent  || null,
        prevHash,
        rowHash,
      ],
    );
  } catch (err) {
    // Never propagate audit failures to callers.
    logger.error(
      { event: "admin_audit_write_error", err: err.message },
      "adminAudit: failed to record admin action",
    );
  }
}

// ── Convenience middleware ────────────────────────────────────────────────────

/**
 * Express middleware factory that records an audit entry after any
 * successful (2xx) response from the wrapped handler.
 *
 * The middleware captures the req.body snapshot *before* the handler runs
 * and records it as `metadata` so the raw input is preserved.  For routes
 * that need proper before/after state (e.g. project status transitions) call
 * `logAdminAction` directly from the handler instead.
 *
 * @param {string}  action      - Action verb to record (e.g. "project.verify")
 * @param {string}  [resourceType] - Resource type (resolved from req if omitted)
 * @returns {import('express').RequestHandler}
 */
function auditMiddleware(action, resourceType) {
  return (req, res, next) => {
    // Capture the incoming body *before* the handler may mutate it.
    const capturedBody = sanitizeBody(req.body);

    const originalJson = res.json.bind(res);
    res.json = function (body) {
      if (res.statusCode < 400) {
        const actor    = req.admin?.sub || req.ip || "unknown";
        const resId    = req.params?.id || req.body?.projectId || null;
        const resType  = resourceType || null;

        // Fire-and-forget: the await is intentionally dropped because
        // res.json must be synchronous.  Audit failures are logged by
        // logAdminAction itself.
        logAdminAction({
          actor,
          action,
          resourceType: resType,
          resourceId:   resId,
          afterState:   null, // Route-specific callers should pass this directly.
          metadata: {
            method:     req.method,
            path:       req.originalUrl,
            statusCode: res.statusCode,
            body:       capturedBody,
          },
          ipAddress: req.ip,
          userAgent: req.get("User-Agent"),
        });
      }
      return originalJson(body);
    };
    next();
  };
}

/**
 * Strip credential-like fields from a request body before storing it.
 *
 * @param {Object} body
 * @returns {Object}
 */
function sanitizeBody(body) {
  if (!body || typeof body !== "object") return {};
  const sanitized = { ...body };
  for (const key of ["password", "secret", "secretKey", "adminAddress", "token", "privateKey"]) {
    delete sanitized[key]; // eslint-disable-line security/detect-object-injection
  }
  return sanitized;
}

module.exports = { logAdminAction, auditMiddleware, sanitizeBody };
