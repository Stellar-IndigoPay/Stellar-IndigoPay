/**
 * backend/src/routes/admin/projections.js
 *
 * Admin API for the event-sourcing projection engine.
 *
 * Endpoints (mounted at /api/admin/projections and /api/v1/admin/projections):
 *   POST /rebuild          — rebuild all projections from the event store
 *   POST /rebuild/:name    — rebuild a single named projection
 *   GET  /status           — current rebuild state + lag
 *
 * All routes are admin-only (adminRequired = X-Admin-Key or Bearer JWT).
 */

"use strict";

const express = require("express");
const router = express.Router();
const { adminRequired } = require("../../middleware/auth");
const { logAdminAction } = require("../../services/audit");
const {
  rebuildAllProjections,
  rebuildProjection,
  isRebuilding,
  refreshLag,
  PROJECTION_NAMES,
} = require("../../services/projectionEngine");
const { metrics } = require("../../services/metrics");
const logger = require("../../logger");

router.post("/rebuild", adminRequired, async (req, res) => {
  try {
    if (isRebuilding()) {
      return res.status(409).json({
        success: false,
        error: "A projection rebuild is already in progress",
      });
    }

    // Kick off synchronously so the response reflects completion. The
    // rebuild is idempotent and trims the event store first, so re-running
    // is safe. (For very large stores an async job would be preferable, but
    // the spec requires a single admin trigger that returns when done.)
    const result = await rebuildAllProjections();

    try {
      await refreshLag();
    } catch {
      // non-fatal
    }

    const actor = (req.admin && req.admin.sub) || "admin";
    logAdminAction({
      actor,
      action: "projections.rebuild_all",
      targetType: "system",
      targetId: "projections",
      metadata: { events: result.events, durationMs: result.durationMs },
      ipAddress: req.ip,
    });

    logger.info(
      { event: "admin_projection_rebuild", result },
      "Admin triggered full projection rebuild",
    );

    res.json({
      success: true,
      data: { eventsReplayed: result.events, durationMs: result.durationMs },
    });
  } catch (err) {
    logger.error(
      { event: "admin_projection_rebuild_error", err: err.message },
      "Admin projection rebuild failed",
    );
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post("/rebuild/:name", adminRequired, async (req, res) => {
  try {
    const { name } = req.params;
    if (!PROJECTION_NAMES.includes(name)) {
      return res.status(404).json({
        success: false,
        error: `Unknown projection "${name}". Valid: ${PROJECTION_NAMES.join(", ")}`,
      });
    }

    const result = await rebuildProjection(name);

    const actor = (req.admin && req.admin.sub) || "admin";
    logAdminAction({
      actor,
      action: `projections.rebuild.${name}`,
      targetType: "system",
      targetId: "projections",
      metadata: { projection: name, events: result.events },
      ipAddress: req.ip,
    });

    res.json({
      success: true,
      data: { projection: name, eventsReplayed: result.events },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/status", adminRequired, async (req, res) => {
  try {
    const lag = await refreshLag().catch(() => 0);
    res.json({
      success: true,
      data: {
        rebuilding: isRebuilding(),
        lag,
        projections: PROJECTION_NAMES,
        lagMetric: metrics.projectionLagEvents ? metrics.projectionLagEvents.get() : lag,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
