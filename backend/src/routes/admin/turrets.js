"use strict";
const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const pool = require("../../db/pool");
const { adminRequired } = require("../../middleware/auth");
const { sendAppError } = require("../../errors");
const { logAdminAction } = require("../../services/audit");

function generateTurretKey() {
  const rawKey = crypto.randomBytes(32).toString("hex");
  const apiKey = `ip_turret_${rawKey}`;
  const hash = crypto.createHash("sha256").update(apiKey).digest("hex");
  return { apiKey, hash };
}

// Issue a new turret credential
router.post("/", adminRequired, async (req, res, next) => {
  try {
    const { name, scope } = req.body || {};
    if (!name || !scope) {
      return sendAppError(res, "VALIDATION_ERROR", {
        reason: "name and scope are required",
      });
    }

    const { apiKey, hash } = generateTurretKey();
    const id = crypto.randomUUID();

    await pool.query(
      `INSERT INTO turrets (id, name, scope, api_key_hash) VALUES ($1, $2, $3, $4)`,
      [id, name, scope, hash]
    );

    await logAdminAction({
      actor: req.admin.sub,
      action: "issue_turret_credential",
      targetType: "turret",
      targetId: id,
      metadata: { name, scope },
      ipAddress: req.ip,
    });

    res.json({ success: true, data: { id, apiKey } });
  } catch (err) {
    next(err);
  }
});

// Rotate a turret credential (dual-key window)
router.post("/:id/rotate", adminRequired, async (req, res, next) => {
  try {
    const { id } = req.params;
    
    // Find existing turret
    const turretResult = await pool.query(
      `SELECT api_key_hash, key_version FROM turrets WHERE id = $1`,
      [id]
    );

    if (turretResult.rows.length === 0) {
      return sendAppError(res, "NOT_FOUND", { reason: "Turret not found" });
    }

    const turret = turretResult.rows[0];
    const { apiKey, hash } = generateTurretKey();

    // Move current hash to prev, set expiry to 24h from now, bump version
    await pool.query(
      `UPDATE turrets 
       SET prev_api_key_hash = $1,
           prev_api_key_expires_at = NOW() + INTERVAL '24 hours',
           api_key_hash = $2,
           key_version = $3,
           updated_at = NOW()
       WHERE id = $4`,
      [turret.api_key_hash, hash, turret.key_version + 1, id]
    );

    await logAdminAction({
      actor: req.admin.sub,
      action: "rotate_turret_credential",
      targetType: "turret",
      targetId: id,
      metadata: { newVersion: turret.key_version + 1 },
      ipAddress: req.ip,
    });

    res.json({ success: true, data: { id, apiKey } });
  } catch (err) {
    next(err);
  }
});

// Revoke a turret credential
router.post("/:id/revoke", adminRequired, async (req, res, next) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `UPDATE turrets 
       SET status = 'revoked',
           api_key_hash = 'revoked_' || api_key_hash,
           prev_api_key_hash = NULL,
           prev_api_key_expires_at = NULL,
           updated_at = NOW()
       WHERE id = $1 AND status != 'revoked'`,
      [id]
    );

    if (result.rowCount === 0) {
      return sendAppError(res, "NOT_FOUND", { reason: "Turret not found or already revoked" });
    }

    await logAdminAction({
      actor: req.admin.sub,
      action: "revoke_turret_credential",
      targetType: "turret",
      targetId: id,
      metadata: {},
      ipAddress: req.ip,
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
