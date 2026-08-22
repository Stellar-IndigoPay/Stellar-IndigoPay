"use strict";
const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const pool = require("../db/pool");
const { sendAppError } = require("../errors");
const { metrics } = require("../services/metrics");

async function authenticateTurret(req, res, next) {
  const apiKey = req.get("X-Turret-Key");
  if (!apiKey) {
    metrics.turretAuthFailuresTotal?.inc();
    return sendAppError(res, "UNAUTHORIZED", { reason: "Missing X-Turret-Key header" });
  }

  const hash = crypto.createHash("sha256").update(apiKey).digest("hex");

  try {
    const result = await pool.query(
      `SELECT id, status FROM turrets 
       WHERE (api_key_hash = $1)
          OR (prev_api_key_hash = $1 AND prev_api_key_expires_at > NOW())`,
      [hash]
    );

    if (result.rows.length === 0) {
      metrics.turretAuthFailuresTotal?.inc();
      return sendAppError(res, "UNAUTHORIZED", { reason: "Invalid or expired X-Turret-Key" });
    }

    const turret = result.rows[0];
    if (turret.status !== "active") {
      metrics.turretAuthFailuresTotal?.inc();
      return sendAppError(res, "FORBIDDEN", { reason: "Turret is not active" });
    }

    req.turret = { id: turret.id };
    next();
  } catch (err) {
    next(err);
  }
}

router.post("/heartbeat", authenticateTurret, async (req, res, next) => {
  try {
    const { id } = req.turret;
    await pool.query(
      `UPDATE turrets SET last_heartbeat = NOW(), updated_at = NOW() WHERE id = $1`,
      [id]
    );
    res.json({ success: true, status: "ok" });
  } catch (err) {
    next(err);
  }
});

router.get("/health", authenticateTurret, async (req, res, next) => {
  try {
    const { id } = req.turret;
    const result = await pool.query(`SELECT last_heartbeat, status FROM turrets WHERE id = $1`, [id]);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
