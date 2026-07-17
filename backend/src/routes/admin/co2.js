/**
 * src/routes/admin/co2.js — Admin CO₂ verification flags
 *
 * Surfaces projects whose self-reported CO₂ offset rate was flagged (or
 * marked for review) by services/co2Verifier.js and lets an admin resolve
 * each flag by accepting or rejecting the claimed rate.
 *
 * Public surface (mounted at /api/admin/co2 and /api/v1/admin/co2):
 *   - GET /benchmarks
 *       The static per-category benchmark table plus the review/flag
 *       multiplier thresholds, so the admin UI can show what a rate was
 *       compared against.
 *   - GET /flags?status=&page=&limit=
 *       Projects needing attention. Defaults to status IN
 *       ('flagged', 'review'); pass ?status= to filter to a single value
 *       (any of pending/verified/review/flagged/rejected).
 *   - PATCH /flags/:projectId/resolve
 *       Body: { resolution: "verified" | "rejected", notes?: string }
 *       Records the admin's decision on the project row and audit log.
 *
 * Admin auth follows the same adminRequired middleware as the rest of
 * the admin surface (Bearer JWT from /api/admin/login).
 */
"use strict";

const express = require("express");
const router = express.Router();
const pool = require("../../db/pool");
const { adminRequired } = require("../../middleware/auth");
const { logAdminAction } = require("../../services/audit");
const {
  CATEGORY_BENCHMARKS,
  CO2_VERIFICATION_STATUSES,
  REVIEW_MULTIPLIER,
  FLAG_MULTIPLIER,
} = require("../../services/co2Verifier");

const RESOLUTIONS = ["verified", "rejected"];

function mapFlaggedProjectRow(row) {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    location: row.location,
    walletAddress: row.wallet_address,
    verified: row.verified,
    co2VerificationStatus: row.co2_verification_status,
    co2VerificationNotes: row.co2_verification_notes || null,
    co2OffsetKg: Number(row.co2_offset_kg || 0),
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

// GET /api/admin/co2/benchmarks
router.get("/benchmarks", adminRequired, (req, res) => {
  res.json({
    success: true,
    data: {
      benchmarks: CATEGORY_BENCHMARKS,
      thresholds: {
        reviewMultiplier: REVIEW_MULTIPLIER,
        flagMultiplier: FLAG_MULTIPLIER,
      },
    },
  });
});

// GET /api/admin/co2/flags
router.get("/flags", adminRequired, async (req, res, next) => {
  try {
    const { status, limit = "50", page = "1" } = req.query;

    if (status && !CO2_VERIFICATION_STATUSES.includes(status)) {
      return res.status(400).json({
        error: `status must be one of: ${CO2_VERIFICATION_STATUSES.join(", ")}`,
      });
    }

    const values = [];
    // Default view is the actionable queue: flagged + review.
    let where = "co2_verification_status IN ('flagged', 'review')";
    if (status) {
      values.push(status);
      where = `co2_verification_status = $${values.length}`;
    }

    const pageSize = Math.min(Number.parseInt(limit, 10) || 50, 200);
    const offset = (Math.max(Number.parseInt(page, 10) || 1, 1) - 1) * pageSize;
    values.push(pageSize, offset);

    // Dynamic WHERE is safe: `status` is validated against the whitelist
    // above and passed as a parameterised $N placeholder.
    // eslint-disable-next-line sql-injection/no-sql-injection
    const result = await pool.query(
      `SELECT id, name, category, location, wallet_address, verified,
              co2_verification_status, co2_verification_notes, co2_offset_kg,
              created_at, updated_at
         FROM projects
        WHERE ${where}
        ORDER BY updated_at DESC
        LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );

    res.json({
      success: true,
      data: result.rows.map(mapFlaggedProjectRow),
      page: Math.max(Number.parseInt(page, 10) || 1, 1),
      pageSize,
    });
  } catch (e) {
    next(e);
  }
});

// PATCH /api/admin/co2/flags/:projectId/resolve
router.patch(
  "/flags/:projectId/resolve",
  adminRequired,
  async (req, res, next) => {
    try {
      const { resolution, notes } = req.body || {};
      if (!RESOLUTIONS.includes(resolution)) {
        return res.status(400).json({
          error: `resolution must be one of: ${RESOLUTIONS.join(", ")}`,
        });
      }
      let notesStr = null;
      if (notes != null && notes !== "") {
        if (typeof notes !== "string" || notes.length > 2000) {
          return res
            .status(400)
            .json({ error: "notes must be a string up to 2000 characters" });
        }
        notesStr = notes.trim();
      }

      const existing = await pool.query(
        "SELECT id, co2_verification_status FROM projects WHERE id = $1",
        [req.params.projectId],
      );
      const row = existing.rows[0];
      if (!row) return res.status(404).json({ error: "Project not found" });

      const updated = await pool.query(
        `UPDATE projects
            SET co2_verification_status = $1,
                co2_verification_notes = COALESCE($2, co2_verification_notes),
                updated_at = NOW()
          WHERE id = $3
          RETURNING id, name, category, location, wallet_address, verified,
                    co2_verification_status, co2_verification_notes,
                    co2_offset_kg, created_at, updated_at`,
        [resolution, notesStr, req.params.projectId],
      );

      const actor = (req.admin && req.admin.sub) || "admin";
      logAdminAction({
        actor,
        action: `co2.resolve.${resolution}`,
        targetType: "project",
        targetId: req.params.projectId,
        metadata: {
          fromStatus: row.co2_verification_status,
          toStatus: resolution,
          notes: notesStr,
        },
        ipAddress: req.ip,
      });

      res.json({ success: true, data: mapFlaggedProjectRow(updated.rows[0]) });
    } catch (e) {
      next(e);
    }
  },
);

module.exports = router;
