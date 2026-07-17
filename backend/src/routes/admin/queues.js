"use strict";

const express = require("express");
const router = express.Router();
const { adminRequired } = require("../../middleware/auth");
const { logAdminAction } = require("../../services/audit");
const {
  isValidQueue,
  getQueueMetrics,
  pauseQueue,
  resumeQueue,
  purgeQueue
} = require("../../services/queueMetrics");
const { sendAppError } = require("../../errors");

// GET /api/admin/queues
router.get("/", adminRequired, async (req, res, next) => {
  try {
    const metrics = await getQueueMetrics();
    res.json({
      success: true,
      data: metrics
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/queues/:name/pause
router.post("/:name/pause", adminRequired, async (req, res, next) => {
  const { name } = req.params;
  if (!isValidQueue(name)) {
    return sendAppError(res, "VALIDATION_ERROR", {
      field: "name",
      detail: `Invalid queue name: ${name}`,
    });
  }

  try {
    await pauseQueue(name);

    await logAdminAction({
      actor: req.admin?.sub || "admin",
      action: "queue.pause",
      targetType: "queue",
      targetId: name,
      metadata: { queue: name },
      ipAddress: req.ip
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/queues/:name/resume
router.post("/:name/resume", adminRequired, async (req, res, next) => {
  const { name } = req.params;
  if (!isValidQueue(name)) {
    return sendAppError(res, "VALIDATION_ERROR", {
      field: "name",
      detail: `Invalid queue name: ${name}`,
    });
  }

  try {
    await resumeQueue(name);

    await logAdminAction({
      actor: req.admin?.sub || "admin",
      action: "queue.resume",
      targetType: "queue",
      targetId: name,
      metadata: { queue: name },
      ipAddress: req.ip
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/queues/:name/purge
router.post("/:name/purge", adminRequired, async (req, res, next) => {
  const { name } = req.params;
  if (!isValidQueue(name)) {
    return sendAppError(res, "VALIDATION_ERROR", {
      field: "name",
      detail: `Invalid queue name: ${name}`,
    });
  }

  try {
    await purgeQueue(name);

    await logAdminAction({
      actor: req.admin?.sub || "admin",
      action: "queue.purge",
      targetType: "queue",
      targetId: name,
      metadata: { queue: name },
      ipAddress: req.ip
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
