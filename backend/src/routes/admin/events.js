"use strict";

/**
 * routes/admin/events.js
 *
 * Admin API endpoints for Soroban event subscription management.
 *
 * POST /api/v1/admin/events/rescan
 *   Manually triggers a re-scan of Soroban contract events from a specified
 *   cursor, or from the beginning if no cursor is provided. Requires admin
 *   authentication.
 *
 * GET /api/v1/admin/events/status
 *   Returns the current status of the Soroban event service (running, cursor,
 *   dedup set size).
 */

const express = require("express");
const router = express.Router();
const { adminRequired } = require("../../middleware/auth");
const { getStatus, rescan, start, stop } = require("../../services/sorobanEventService");
const logger = require("../../logger");

// Apply admin authentication to all routes in this router, following the
// same pattern as webhooks.js, queues.js, and other admin sub-routers.
router.use(adminRequired);

/**
 * GET /api/v1/admin/events/status
 *
 * Returns the current health and state of the Soroban event service.
 * Requires admin authentication.
 */
router.get("/status", async (req, res) => {
  try {
    const status = getStatus();
    res.json({ success: true, data: status });
  } catch (err) {
    logger.error(
      { event: "admin_events_status_error", err: err.message },
      "Failed to get Soroban event service status",
    );
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

/**
 * POST /api/v1/admin/events/rescan
 *
 * Triggers a manual re-scan of Soroban contract events. Accepts an optional
 * `cursor` in the request body — if omitted, scanning starts from the
 * beginning of event history (within RPC retention).
 *
 * Body: { cursor?: string }
 */
router.post("/rescan", async (req, res) => {
  try {
    const { cursor } = req.body || {};

    logger.warn(
      {
        event: "admin_events_rescan_requested",
        admin: req.admin?.sub || "unknown",
        cursor: cursor || "(start)",
      },
      "Admin requested Soroban event rescan",
    );

    const result = await rescan(cursor || "");
    res.json({ success: true, data: result });
  } catch (err) {
    logger.error(
      { event: "admin_events_rescan_error", err: err.message },
      "Failed to trigger Soroban event rescan",
    );
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

/**
 * POST /api/v1/admin/events/restart
 *
 * Restarts the Soroban event service. Useful after configuration changes
 * or to recover from a stalled state.
 */
router.post("/restart", async (req, res) => {
  try {
    logger.warn(
      {
        event: "admin_events_restart_requested",
        admin: req.admin?.sub || "unknown",
      },
      "Admin requested Soroban event service restart",
    );

    await stop();
    await start();

    res.json({ success: true, data: { message: "Service restarted" } });
  } catch (err) {
    logger.error(
      { event: "admin_events_restart_error", err: err.message },
      "Failed to restart Soroban event service",
    );
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

module.exports = router;
