"use strict";

/**
 * src/routes/admin/retention.js
 *
 * Admin API for the data-retention worker.
 *
 * Mounted under /api/admin/retention (see routes/admin.js):
 *   - GET  /api/admin/retention/status
 *       Returns configured policies, pending row counts (when the DB is
 *       reachable), last execution, strategy and retention period.
 *   - POST /api/admin/retention/run-now
 *       Manually executes one or all policies. Validates the policy name
 *       before execution and returns structured errors.
 *
 * Auth: adminRequired (X-Admin-Key header or Bearer token), matching every
 * other admin sub-route. Every manual run is recorded via the audit service
 * by the worker itself.
 */

const express = require("express");
const router = express.Router();
const pool = require("../../db/pool");
const { adminRequired } = require("../../middleware/auth");
const { sendAppError } = require("../../errors");
const {
  getStatus,
  runAllPolicies,
  runPolicy,
  byName,
} = require("../../services/retentionWorker");

// GET /api/admin/retention/status
router.get("/status", adminRequired, async (req, res, next) => {
  try {
    const status = await getStatus(pool);
    return res.status(200).json({ success: true, data: status });
  } catch (err) {
    return next(err);
  }
});

// POST /api/admin/retention/run-now
// Body: { policy?: string }  — omit policy to run all configured policies.
router.post("/run-now", adminRequired, async (req, res, next) => {
  try {
    const { policy } = req.body || {};
    const actor = req.admin?.sub || "admin";

    if (policy != null) {
      if (typeof policy !== "string" || !policy.trim()) {
        return sendAppError(res, "VALIDATION_ERROR", {
          field: "policy",
          detail: "policy must be a non-empty string when provided",
        });
      }
      const found = byName(policy);
      if (!found) {
        return sendAppError(res, "VALIDATION_ERROR", {
          field: "policy",
          detail: `Unknown retention policy: ${policy}`,
        });
      }
      const results = [await runPolicy(pool, found, { actor })];
      const failed = results.filter((r) => r.status === "failed");
      return res.status(failed.length ? 207 : 200).json({
        success: failed.length === 0,
        data: results,
      });
    }

    const results = await runAllPolicies(pool, { actor });
    const failed = results.filter((r) => r.status === "failed");
    return res.status(failed.length ? 207 : 200).json({
      success: failed.length === 0,
      data: results,
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
