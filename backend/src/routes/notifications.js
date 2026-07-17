/**
 * src/routes/notifications.js
 * POST /api/notifications/register      — register device token
 * POST /api/notifications/follow        — follow a project
 * POST /api/notifications/unfollow      — unfollow a project
 * GET  /api/notifications/follows       — get user's followed projects
 * GET  /api/notifications/unread-count  — unread project update count for a device
 */
"use strict";
const express = require("express");
const router = express.Router();
const { v4: uuidv4 } = require("uuid");
const pool = require("../db/pool");
const { AppError } = require("../errors");
const { verifyUnsubscribeToken } = require("../services/digestBuilder");

function parseLastSeen(value) {
  if (!value || typeof value !== "string") return null;

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseUnreadCount(row) {
  const value = row?.unread_count ?? row?.count ?? 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

// GET /api/notifications/unread-count
// Return the number of unread project updates for projects followed by a device token.
router.get("/unread-count", async (req, res, next) => {
  try {
    const { token, lastSeen } = req.query;

    if (!token || typeof token !== "string") {
      throw new AppError("VALIDATION_ERROR", { field: "token" });
    }

    const lastSeenAt = parseLastSeen(lastSeen);
    if (lastSeen !== undefined && !lastSeenAt) {
      throw new AppError("VALIDATION_ERROR", {
        field: "lastSeen",
        detail: "lastSeen must be a valid ISO-8601 timestamp",
      });
    }

    const tokenResult = await pool.query(
      "SELECT id FROM device_tokens WHERE token = $1",
      [token],
    );

    if (!tokenResult.rows[0]) {
      throw new AppError("DEVICE_TOKEN_NOT_FOUND");
    }

    const params = [tokenResult.rows[0].id];
    let unreadSinceClause = "";

    if (lastSeenAt) {
      params.push(lastSeenAt.toISOString());
      unreadSinceClause = `AND pu.created_at > $${params.length}`;
    }

    const countResult = await pool.query(
      `SELECT COUNT(*) AS unread_count
       FROM project_updates pu
       JOIN project_follows pf ON pf.project_id = pu.project_id
       WHERE pf.device_token_id = $1
       ${unreadSinceClause}`,
      params,
    );

    res.json({ unreadCount: parseUnreadCount(countResult.rows[0]) });
  } catch (e) {
    next(e);
  }
});

// POST /api/notifications/register
// Register or update a device token
router.post("/register", async (req, res, next) => {
  try {
    const { token, platform, walletAddress } = req.body;

    if (!token || typeof token !== "string") {
      throw new AppError("VALIDATION_ERROR", { field: "token" });
    }
    if (!platform || typeof platform !== "string") {
      throw new AppError("VALIDATION_ERROR", {
        field: "platform",
        detail: "platform is required (ios/android)",
      });
    }
    if (!["ios", "android"].includes(platform.toLowerCase())) {
      throw new AppError("VALIDATION_ERROR", {
        field: "platform",
        detail: "platform must be either ios or android",
      });
    }

    const normalizedPlatform = platform.toLowerCase();

    // Check if token exists
    const existingResult = await pool.query(
      "SELECT * FROM device_tokens WHERE token = $1",
      [token],
    );

    if (existingResult.rows[0]) {
      // Update existing token — re-activate and refresh address
      await pool.query(
        `UPDATE device_tokens 
         SET platform = $1, wallet_address = $2, is_active = true, updated_at = NOW()
         WHERE token = $3`,
        [normalizedPlatform, walletAddress || null, token],
      );
      res.json({ success: true, data: { tokenId: existingResult.rows[0].id } });
    } else {
      // Insert new token
      const id = uuidv4();
      await pool.query(
        `INSERT INTO device_tokens (id, token, platform, wallet_address)
         VALUES ($1, $2, $3, $4)`,
        [id, token, normalizedPlatform, walletAddress || null],
      );
      res.json({ success: true, data: { tokenId: id } });
    }
  } catch (e) {
    next(e);
  }
});

// POST /api/notifications/follow
// Follow a project for push notifications
router.post("/follow", async (req, res, next) => {
  try {
    const { projectId, token, walletAddress } = req.body;

    if (!projectId || typeof projectId !== "string") {
      throw new AppError("VALIDATION_ERROR", { field: "projectId" });
    }
    if (!token || typeof token !== "string") {
      throw new AppError("VALIDATION_ERROR", { field: "token" });
    }

    // Get device token ID
    const tokenResult = await pool.query(
      "SELECT id FROM device_tokens WHERE token = $1",
      [token],
    );

    if (!tokenResult.rows[0]) {
      throw new AppError("DEVICE_TOKEN_NOT_FOUND", {
        detail: "Please register first",
      });
    }

    const deviceId = tokenResult.rows[0].id;

    // Check if project exists
    const projectResult = await pool.query(
      "SELECT id FROM projects WHERE id = $1",
      [projectId],
    );

    if (!projectResult.rows[0]) {
      throw new AppError("PROJECT_NOT_FOUND");
    }

    // Check if already following
    const existingFollow = await pool.query(
      "SELECT * FROM project_follows WHERE project_id = $1 AND device_token_id = $2",
      [projectId, deviceId],
    );

    if (existingFollow.rows[0]) {
      return res.json({
        success: true,
        message: "Already following this project",
      });
    }

    // Create follow relationship
    const followId = uuidv4();
    await pool.query(
      `INSERT INTO project_follows (id, project_id, device_token_id, wallet_address)
       VALUES ($1, $2, $3, $4)`,
      [followId, projectId, deviceId, walletAddress || null],
    );

    res.status(201).json({ success: true, data: { followId } });
  } catch (e) {
    next(e);
  }
});

// POST /api/notifications/unfollow
// Unfollow a project
router.post("/unfollow", async (req, res, next) => {
  try {
    const { projectId, token } = req.body;

    if (!projectId || typeof projectId !== "string") {
      throw new AppError("VALIDATION_ERROR", { field: "projectId" });
    }
    if (!token || typeof token !== "string") {
      throw new AppError("VALIDATION_ERROR", { field: "token" });
    }

    // Get device token ID
    const tokenResult = await pool.query(
      "SELECT id FROM device_tokens WHERE token = $1",
      [token],
    );

    if (!tokenResult.rows[0]) {
      throw new AppError("DEVICE_TOKEN_NOT_FOUND");
    }

    const deviceId = tokenResult.rows[0].id;

    // Delete follow relationship
    const result = await pool.query(
      "DELETE FROM project_follows WHERE project_id = $1 AND device_token_id = $2",
      [projectId, deviceId],
    );

    res.json({ success: true, deleted: result.rowCount > 0 });
  } catch (e) {
    next(e);
  }
});

// GET /api/notifications/follows
// Get all projects followed by a device
router.get("/follows", async (req, res, next) => {
  try {
    const { token } = req.query;

    if (!token || typeof token !== "string") {
      throw new AppError("VALIDATION_ERROR", { field: "token" });
    }

    // Get device token ID
    const tokenResult = await pool.query(
      "SELECT id FROM device_tokens WHERE token = $1",
      [token],
    );

    if (!tokenResult.rows[0]) {
      throw new AppError("DEVICE_TOKEN_NOT_FOUND");
    }

    const deviceId = tokenResult.rows[0].id;

    // Get followed projects
    const result = await pool.query(
      `SELECT p.id, p.name, p.category, p.location, p.description, pf.created_at as followed_at
       FROM project_follows pf
       JOIN projects p ON pf.project_id = p.id
       WHERE pf.device_token_id = $1
       ORDER BY pf.created_at DESC`,
      [deviceId],
    );

    res.json({ success: true, data: result.rows });
  } catch (e) {
    next(e);
  }
});

// GET /api/notifications/preferences
// Return push-notification preferences for a wallet.
router.get("/preferences", async (req, res, next) => {
  try {
    const { walletAddress } = req.query;

    if (!walletAddress || typeof walletAddress !== "string") {
      return res
        .status(400)
        .json({ error: "walletAddress query parameter is required" });
    }

    const { rows } = await pool.query(
      `SELECT type, enabled, channel
       FROM notification_preferences
       WHERE wallet_address = $1 AND channel = 'push'
       ORDER BY (type IS NULL) ASC`,
      [walletAddress],
    );

    // Also fetch DND settings from the profiles table (JSONB column).
    const profileResult = await pool.query(
      "SELECT notification_dnd FROM profiles WHERE public_key = $1",
      [walletAddress],
    );

    const preferences = {};
    for (const row of rows) {
      if (row.type === null) {
        preferences._all = row.enabled;
      } else {
        preferences[row.type] = row.enabled;
      }
    }

    res.json({
      success: true,
      data: {
        walletAddress,
        preferences,
        dnd: profileResult.rows[0]?.notification_dnd || null,
      },
    });
  } catch (e) {
    next(e);
  }
});

// PUT /api/notifications/preferences
// Update push-notification preferences for a wallet.
// Body: { walletAddress, preferences: { donation_receipt: true, ... }, dnd?: { start, end, timezone } }
router.put("/preferences", async (req, res, next) => {
  try {
    const { walletAddress, preferences, dnd } = req.body || {};

    if (!walletAddress || typeof walletAddress !== "string") {
      return res.status(400).json({ error: "walletAddress is required" });
    }
    if (!preferences || typeof preferences !== "object") {
      return res.status(400).json({ error: "preferences object is required" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Upsert each preference entry — use DELETE+INSERT for simplicity
      // and portability (avoids partial-unique-index ON CONFLICT subtleties).
      for (const [type, enabled] of Object.entries(preferences)) {
        const typeVal = type === "_all" ? null : type;
        const enabledBool = Boolean(enabled);

        await client.query(
          `DELETE FROM notification_preferences
           WHERE wallet_address = $1 AND channel = 'push' AND (
             (type = $2) OR (type IS NULL AND $2 IS NULL)
           )`,
          [walletAddress, typeVal],
        );
        await client.query(
          `INSERT INTO notification_preferences (id, wallet_address, channel, type, enabled)
           VALUES ($1, $2, 'push', $3, $4)`,
          [uuidv4(), walletAddress, typeVal, enabledBool],
        );
      }

      // Persist DND settings in the profiles table
      if (dnd !== undefined) {
        await client.query(
          `UPDATE profiles SET notification_dnd = $1, updated_at = NOW()
           WHERE public_key = $2`,
          [dnd ? JSON.stringify(dnd) : null, walletAddress],
        );
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    res.json({ success: true, data: { walletAddress, preferences, dnd: dnd || null } });
  } catch (e) {
    next(e);
  }
});

// POST /api/notifications/unregister
// Mark a device token as inactive (e.g., when a token is invalid or user
// uninstalls the app). The token is NOT deleted — stale tokens are kept
// for auditing but excluded from push sends.
router.post("/unregister", async (req, res, next) => {
  try {
    const { token } = req.body || {};

    if (!token || typeof token !== "string") {
      return res.status(400).json({ error: "token is required" });
    }

    const result = await pool.query(
      "UPDATE device_tokens SET is_active = false, updated_at = NOW() WHERE token = $1 RETURNING id",
      [token],
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Device token not found" });
    }

    res.json({ success: true, data: { tokenId: result.rows[0].id, active: false } });
  } catch (e) {
    next(e);
  }
});

// GET /api/notifications/unsubscribe
// Disable email digest delivery for the wallet address encoded in the token.
router.get("/unsubscribe", async (req, res, next) => {
  try {
    const { token } = req.query || {};

    if (!token || typeof token !== "string") {
      throw new AppError("VALIDATION_ERROR", { field: "token" });
    }

    let payload;
    try {
      payload = verifyUnsubscribeToken(token);
    } catch (err) {
      throw new AppError("VALIDATION_ERROR", {
        field: "token",
        detail: err.message,
      });
    }

    await pool.query(
      `INSERT INTO notification_preferences (id, wallet_address, channel, type, enabled)
       VALUES ($1, $2, 'email', 'digest', false)
       ON CONFLICT (wallet_address, channel, type)
       DO UPDATE SET enabled = false, updated_at = NOW()`,
      [uuidv4(), payload.walletAddress],
    );

    res.json({ success: true, message: "Digest emails unsubscribed successfully" });
  } catch (e) {
    next(e);
  }
});

// PATCH /api/notifications/preferences
// Update a single project-level notification preference.
// Body: { walletAddress, projectId, channel, enabled }
router.patch("/preferences", async (req, res, next) => {
  try {
    const { walletAddress, projectId, channel, enabled } = req.body || {};

    if (!walletAddress || typeof walletAddress !== "string") {
      return res.status(400).json({ error: "walletAddress is required" });
    }
    if (!projectId || typeof projectId !== "string") {
      return res.status(400).json({ error: "projectId is required" });
    }
    if (!channel || typeof channel !== "string") {
      return res.status(400).json({ error: "channel is required" });
    }
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ error: "enabled must be a boolean" });
    }

    await pool.query(
      `INSERT INTO notification_preferences (id, wallet_address, project_id, channel, enabled)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (wallet_address, project_id, channel)
       WHERE project_id IS NOT NULL
       DO UPDATE SET enabled = $5, updated_at = NOW()`,
      [uuidv4(), walletAddress, projectId, channel, enabled],
    );

    res.json({ success: true, data: { walletAddress, projectId, channel, enabled } });
  } catch (e) {
    next(e);
  }
});

// GET /api/notifications/inbox
// List in-app notifications for a wallet, newest first.
router.get("/inbox", async (req, res, next) => {
  try {
    const { walletAddress } = req.query;
    const limit = Math.min(parseInt(req.query.limit || "50", 10), 100);
    const offset = parseInt(req.query.offset || "0", 10);

    if (!walletAddress || typeof walletAddress !== "string") {
      return res.status(400).json({ error: "walletAddress query parameter is required" });
    }

    const { rows } = await pool.query(
      `SELECT id, title, body, data, read, created_at
       FROM in_app_notifications
       WHERE wallet_address = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [walletAddress, limit, offset],
    );

    const countResult = await pool.query(
      "SELECT COUNT(*) AS total FROM in_app_notifications WHERE wallet_address = $1",
      [walletAddress],
    );

    const unreadResult = await pool.query(
      "SELECT COUNT(*) AS unread FROM in_app_notifications WHERE wallet_address = $1 AND read = FALSE",
      [walletAddress],
    );

    res.json({
      success: true,
      data: {
        notifications: rows,
        total: parseInt(countResult.rows[0].total, 10),
        unread: parseInt(unreadResult.rows[0].unread, 10),
        limit,
        offset,
      },
    });
  } catch (e) {
    next(e);
  }
});

// POST /api/notifications/inbox/:id/read
// Mark a single in-app notification as read.
router.post("/inbox/:id/read", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { walletAddress } = req.body || {};

    if (!walletAddress || typeof walletAddress !== "string") {
      return res.status(400).json({ error: "walletAddress is required in body" });
    }

    const result = await pool.query(
      `UPDATE in_app_notifications SET read = TRUE
       WHERE id = $1 AND wallet_address = $2
       RETURNING id, read`,
      [id, walletAddress],
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Notification not found" });
    }

    res.json({ success: true, data: { id, read: true } });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
