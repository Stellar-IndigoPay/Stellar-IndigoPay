/**
 * src/routes/admin/co2.js — Admin CO₂ verification flags
 *
 * Surfaces projects whose self-reported CO₂ offset rate was flagged (or
 * marked for review) by services/co2Verifier.js and lets an admin resolve
 * each flag by accepting or rejecting the claimed rate. Also provides
 * endpoints to trigger automated verification runs.
 *
 * Public surface (mounted at /api/admin/co2 and /api/v1/admin/co2):
 *   - GET /benchmarks
 *       The static per-category benchmark table plus the review/flag
 *       multiplier thresholds, so the admin UI can show what a rate was
 *       compared against.
 *   - GET /flags?status=&page=&limit=
 *       Projects needing attention. Defaults to status IN
 *       ('flagged', 'review'); pass ?status= to filter to a single value
 *       (any of pending/verified/review/flagged/rejected). Each row now
 *       includes the latest verification run's confidenceBand,
 *       referenceSource, deviationPercent, and severity.
 *   - GET /flags/:projectId/history
 *       Full co2_verification_runs history for a single project.
 *   - POST /verify-all
 *       Triggers verification for all active projects. Returns summary.
 *   - POST /verify/:projectId
 *       Triggers verification for a single project.
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
  verifyProjectCO2Rate,
  runVerificationForAllProjects,
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
    // Latest verification run data (if joined)
    confidenceLower: row.confidence_lower !== undefined ? Number(row.confidence_lower) : null,
    confidenceUpper: row.confidence_upper !== undefined ? Number(row.confidence_upper) : null,
    referenceSource: row.reference_source || null,
    deviationPercent: row.deviation_percent !== undefined ? Number(row.deviation_percent) : null,
    severity: row.severity || null,
    verifiedAt: row.verified_at ? new Date(row.verified_at).toISOString() : null,
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

    // Join with the latest verification run to surface confidence band,
    // reference source, and deviation % in the admin table.
    // Dynamic WHERE is safe: `status` is validated against the whitelist
    // above and passed as a parameterised $N placeholder.
    // eslint-disable-next-line sql-injection/no-sql-injection
    const result = await pool.query(
      `SELECT p.id, p.name, p.category, p.location, p.wallet_address,
              p.verified, p.co2_verification_status, p.co2_verification_notes,
              p.co2_offset_kg, p.created_at, p.updated_at,
              v.confidence_lower, v.confidence_upper, v.reference_source,
              v.verified_at,
              CASE
                WHEN v.confidence_upper > 0 AND p.co2_offset_kg * 1000 > v.confidence_upper
                THEN ROUND(((p.co2_offset_kg * 1000 - v.confidence_upper)::numeric / v.confidence_upper) * 100)
                ELSE 0
              END AS deviation_percent,
              CASE
                WHEN v.confidence_upper > 0 AND p.co2_offset_kg * 1000 > v.confidence_upper * 3.0
                THEN 'critical'
                WHEN v.confidence_upper > 0 AND p.co2_offset_kg * 1000 > v.confidence_upper * 1.5
                THEN 'warning'
                ELSE 'none'
              END AS severity
         FROM projects p
         LEFT JOIN LATERAL (
           SELECT confidence_lower, confidence_upper, reference_source, verified_at
             FROM co2_verification_runs
            WHERE project_id = p.id
            ORDER BY verified_at DESC
            LIMIT 1
         ) v ON true
        WHERE ${where}
        ORDER BY p.updated_at DESC
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

// GET /api/admin/co2/flags/:projectId/history — full verification run history
router.get("/flags/:projectId/history", adminRequired, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, project_id, claimed_rate, confidence_lower, confidence_upper,
              is_plausible, reference_source, satellite_source, flag_reason,
              verified_at
         FROM co2_verification_runs
        WHERE project_id = $1
        ORDER BY verified_at DESC
        LIMIT 50`,
      [req.params.projectId],
    );

    res.json({
      success: true,
      data: result.rows.map((row) => ({
        id: row.id,
        projectId: row.project_id,
        claimedRate: Number(row.claimed_rate),
        confidenceLower: Number(row.confidence_lower),
        confidenceUpper: Number(row.confidence_upper),
        isPlausible: row.is_plausible,
        referenceSource: row.reference_source,
        satelliteSource: row.satellite_source || null,
        flagReason: row.flag_reason || null,
        verifiedAt: row.verified_at ? new Date(row.verified_at).toISOString() : null,
      })),
    });
  } catch (e) {
    next(e);
  }
});

// POST /api/admin/co2/verify-all — trigger verification for all active projects
router.post("/verify-all", adminRequired, async (req, res, next) => {
  try {
    const summary = await runVerificationForAllProjects();

    const actor = (req.admin && req.admin.sub) || "admin";
    logAdminAction({
      actor,
      action: "co2.verify_all",
      targetType: "system",
      targetId: "batch",
      metadata: {
        total: summary.total,
        plausible: summary.plausible,
        warning: summary.warning,
        critical: summary.critical,
        errors: summary.errors,
      },
      ipAddress: req.ip,
    });

    // Only return summary + flagged/critical results to keep the payload small
    const flaggedResults = summary.results.filter(
      (r) => r.severity === "warning" || r.severity === "critical" || r.error,
    );

    res.json({
      success: true,
      data: {
        total: summary.total,
        plausible: summary.plausible,
        warning: summary.warning,
        critical: summary.critical,
        errors: summary.errors,
        flaggedResults,
      },
    });
  } catch (e) {
    next(e);
  }
});

// POST /api/admin/co2/verify/:projectId — verify a single project
router.post("/verify/:projectId", adminRequired, async (req, res, next) => {
  try {
    const existing = await pool.query(
      `SELECT id, name, category, location, wallet_address, co2_offset_kg
         FROM projects
        WHERE id = $1`,
      [req.params.projectId],
    );
    const project = existing.rows[0];
    if (!project) return res.status(404).json({ error: "Project not found" });

    const result = await verifyProjectCO2Rate(project);

    const actor = (req.admin && req.admin.sub) || "admin";
    logAdminAction({
      actor,
      action: "co2.verify_single",
      targetType: "project",
      targetId: req.params.projectId,
      metadata: {
        severity: result.severity,
        isPlausible: result.isPlausible,
        deviationPercent: result.deviationPercent,
      },
      ipAddress: req.ip,
    });

    res.json({ success: true, data: result });
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
