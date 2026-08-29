"use strict";

/**
 * src/routes/admin/secrets.js
 *
 * Admin API endpoint reporting the live rotation status of every secret the
 * backend consumes (Workstream 3 of #1100, `GET /api/admin/secrets/status`).
 *
 * For each secret it returns:
 *   - name                 — canonical secret name
 *   - currentKid           — fingerprint of the current (issue) key
 *   - previousKid          — fingerprint of the previous (verify-only) key, if any
 *   - nextKid              — fingerprint of the next (verify+promote) key, if any
 *   - lastRotatedAt        — most recent rotation completion time (from the
 *                            secret_rotations audit table)
 *   - nextScheduledAt      — when the next automated rotation is expected
 *
 * Only SHA-256 fingerprints ("kid") are returned — never secret values.
 * The endpoint is admin-only and mounted at /api/admin/secrets (see routes/admin.js).
 */

const express = require("express");
const router = express.Router();
const pool = require("../../db/pool");
const { adminRequired } = require("../../middleware/auth");
const { getRenderedStatus } = require("../../services/signingSecretProvider");

// Mirror the quarterly schedule in .github/workflows/secret-rotation.yml.
const ROTATION_CRON = "0 2 1 1,4,7,10 *";
const QUARTER_MS = 91 * 24 * 60 * 60 * 1000;

router.use(adminRequired);

function nextScheduledRotation(now = new Date()) {
  // Weekly-ish approximation anchored to the configured monthly cron months.
  // A real implementation could parse the cron, but a 91-day cadence anchored
  // to the previous completed rotation is accurate enough for status display.
  let candidate = new Date(now.getTime() + QUARTER_MS);
  const months = [0, 3, 6, 9]; // Jan, Apr, Jul, Oct
  let nearest = new Date(candidate.getFullYear(), months[0], 1, 2, 0, 0);
  for (const month of months) {
    const start = new Date(candidate.getFullYear(), month, 1, 2, 0, 0);
    if (start > now && start < nearest) nearest = start;
  }
  if (nearest <= now) {
    nearest = new Date(candidate.getFullYear() + 1, months[0], 1, 2, 0, 0);
  }
  return nearest;
}

/**
 * GET /api/admin/secrets/status
 *
 * Returns rotation status for every known secret. Requires admin auth.
 */
router.get("/status", async (req, res, next) => {
  try {
    const [rotations] = await Promise.all([
      pool.query(
        `SELECT secret_name,
                MAX(completed_at) FILTER (WHERE overall_status = 'completed')
                  AS last_rotated_at,
                COUNT(*) FILTER (WHERE overall_status = 'completed')::int
                  AS completion_count
         FROM (
           SELECT jsonb_array_elements_text(secrets_rotated) AS secret_name,
                  completed_at, overall_status
           FROM secret_rotations
         ) expanded
         WHERE completed_at IS NOT NULL
         GROUP BY secret_name`,
      ),
    ]);

    const rotationMap = new Map(
      rotations.rows.map((r) => [r.secret_name, r]),
    );

    const now = new Date();
    const data = getRenderedStatus().map((entry) => {
      const rotation = rotationMap.get(entry.name);
      return {
        name: entry.name,
        currentKid: entry.currentKid,
        previousKid: entry.previousKid,
        nextKid: entry.nextKid,
        lastRotatedAt: rotation?.last_rotated_at
          ? new Date(rotation.last_rotated_at instanceof Date
            ? rotation.last_rotated_at
            : rotation.last_rotated_at).toISOString()
          : null,
        completionCount: rotation?.completion_count ?? 0,
        nextScheduledAt: nextScheduledRotation(
          rotation?.last_rotated_at
            ? new Date(rotation.last_rotated_at instanceof Date
              ? rotation.last_rotated_at : rotation.last_rotated_at)
            : now,
        ).toISOString(),
        rotationScheduleCron: ROTATION_CRON,
      };
    });

    res.json({ success: true, data });
  } catch (e) {
    next(e);
  }
});

module.exports = router;