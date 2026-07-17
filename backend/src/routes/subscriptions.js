/**
 * src/routes/subscriptions.js
 * POST /api/subscriptions        — subscribe to project updates
 * GET  /api/subscriptions/:projectId/count — subscriber count
 */
"use strict";
const express = require("express");
const router = express.Router();
const { v4: uuidv4 } = require("uuid");
const pool = require("../db/pool");
const { AppError } = require("../errors");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// POST /api/subscriptions
router.post("/", async (req, res, next) => {
  try {
    const { projectId, email, donorAddress } = req.body;

    if (!projectId || typeof projectId !== "string") {
      throw new AppError("VALIDATION_ERROR", { field: "projectId" });
    }
    if (!email || !EMAIL_RE.test(email)) {
      throw new AppError("VALIDATION_ERROR", {
        field: "email",
        detail: "A valid email is required",
      });
    }

    // Verify project exists
    const proj = await pool.query("SELECT id FROM projects WHERE id = $1", [
      projectId,
    ]);
    if (!proj.rows[0]) throw new AppError("PROJECT_NOT_FOUND");

    const insertResult = await pool.query(
      `INSERT INTO project_subscriptions (id, project_id, email, donor_address)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (project_id, email) DO NOTHING
       RETURNING id`,
      [uuidv4(), projectId, email.toLowerCase().trim(), donorAddress || null],
    );

    if (insertResult.rowCount === 0) {
      throw new AppError("DUPLICATE_SUBSCRIPTION");
    }

    res.status(201).json({ success: true, message: "Subscribed successfully" });
  } catch (e) {
    next(e);
  }
});

// GET /api/subscriptions/:projectId/count
router.get("/:projectId/count", async (req, res, next) => {
  try {
    const result = await pool.query(
      "SELECT COUNT(*)::int AS count FROM project_subscriptions WHERE project_id = $1",
      [req.params.projectId],
    );
    res.json({ success: true, count: result.rows[0].count });
  } catch (e) {
    next(e);
  }
});

// DELETE /api/subscriptions/:id
router.delete("/:id", async (req, res, next) => {
  try {
    const { email, donorAddress } = req.body;

    if (!email && !donorAddress) {
      throw new AppError("VALIDATION_ERROR", {
        detail: "email or donorAddress is required to unsubscribe",
      });
    }

    const sub = await pool.query(
      "SELECT email, donor_address FROM project_subscriptions WHERE id = $1",
      [req.params.id],
    );

    if (!sub.rows[0]) {
      throw new AppError("SUBSCRIPTION_NOT_FOUND");
    }

    const record = sub.rows[0];

    let authorized = false;
    if (email && email.toLowerCase().trim() === record.email) {
      authorized = true;
    } else if (donorAddress && donorAddress === record.donor_address) {
      authorized = true;
    }

    if (!authorized) {
      throw new AppError("FORBIDDEN", {
        detail: "Unauthorized to delete this subscription",
      });
    }

    await pool.query("DELETE FROM project_subscriptions WHERE id = $1", [
      req.params.id,
    ]);

    res.json({ success: true, message: "Unsubscribed successfully" });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
