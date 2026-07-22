/**
 * src/routes/matches.js
 *
 * Public endpoints for querying donation match pools.
 * Mounted at /api/matches and /api/v1/matches.
 *
 * GET /              — List matches; filter by ?projectId=uuid&active=true
 * GET /:id/stats     — Matching impact metrics for a single pool
 */
"use strict";

const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { AppError } = require("../errors");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Map a database row to the public camelCase shape.
 * Includes computed fields: progressPct, remainingXLM, effectiveStatus.
 */
function mapPublicMatchRow(row) {
  const capXlm = parseFloat(row.cap_xlm || "0");
  const matchedXlm = parseFloat(row.matched_xlm || "0");
  const remainingXlm = Math.max(0, capXlm - matchedXlm);
  const progressPct = capXlm > 0 ? Math.min(100, (matchedXlm / capXlm) * 100) : 0;

  // Derive effective status for display (DB status is authoritative, but
  // we surface a human-readable label that accounts for edge states).
  let effectiveStatus = row.status;
  if (row.status === "active") {
    if (new Date(row.expires_at) < new Date()) effectiveStatus = "expired";
    else if (matchedXlm >= capXlm) effectiveStatus = "exhausted";
  }

  return {
    id: row.id,
    projectId: row.project_id,
    matcherAddress: row.matcher_address,
    capXLM: row.cap_xlm,
    multiplier: row.multiplier,
    matchedXLM: row.matched_xlm,
    remainingXLM: remainingXlm.toFixed(7),
    progressPct: parseFloat(progressPct.toFixed(2)),
    expiresAt: row.expires_at,
    status: row.status,
    effectiveStatus,
    createdAt: row.created_at,
  };
}

/**
 * GET /api/matches
 *
 * List donation match pools, optionally filtered.
 *
 * @query {string}  [projectId] - Filter to a specific project UUID.
 * @query {boolean} [active]    - When "true", only return status='active' pools that have not expired.
 */
router.get("/", async (req, res, next) => {
  try {
    const { projectId, active } = req.query;

    const conditions = [];
    const values = [];

    if (projectId) {
      if (!UUID_RE.test(projectId)) {
        throw new AppError("VALIDATION_ERROR", { field: "projectId" });
      }
      values.push(projectId);
      conditions.push(`dm.project_id = $${values.length}`);
    }

    if (active === "true") {
      conditions.push("dm.status = 'active'");
      conditions.push("dm.expires_at > NOW()");
      conditions.push("dm.matched_xlm < dm.cap_xlm");
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    // eslint-disable-next-line sql-injection/no-sql-injection
    const result = await pool.query(
      `SELECT dm.*,
              (dm.matched_xlm / NULLIF(dm.cap_xlm, 0) * 100) AS progress_pct,
              CASE
                WHEN dm.expires_at < NOW() THEN 'expired'
                WHEN dm.matched_xlm >= dm.cap_xlm THEN 'exhausted'
                ELSE dm.status
              END AS effective_status
         FROM donation_matches dm
         ${whereClause}
         ORDER BY dm.created_at DESC`,
      values,
    );

    return res.json({ success: true, data: result.rows.map(mapPublicMatchRow) });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/matches/:id/stats
 *
 * Matching impact metrics for a single match pool:
 *   - total_matched: sum of XLM donated as matching contributions
 *   - match_transactions: count of matching donation records
 *   - donors_reached: count of distinct donor addresses whose donations triggered a match
 *   - avg_match_xlm: average matching amount per match transaction
 */
router.get("/:id/stats", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) {
      throw new AppError("VALIDATION_ERROR", { field: "id" });
    }

    // Load the match pool to confirm it exists and get its project scope
    const matchResult = await pool.query(
      "SELECT * FROM donation_matches WHERE id = $1",
      [id],
    );
    if (!matchResult.rows[0]) {
      throw new AppError("NOT_FOUND", { message: "Match pool not found" });
    }
    const match = matchResult.rows[0];

    // Impact metrics: matching donations are identified by the synthetic
    // transaction_hash pattern "match-<originalTxHash>-<matchId>" written
    // by donations.js during the matching loop.
    const statsResult = await pool.query(
      `SELECT
         COUNT(*)::int                              AS match_transactions,
         COALESCE(SUM(amount_xlm), 0)              AS total_matched,
         COUNT(DISTINCT donor_address)::int         AS donors_reached,
         COALESCE(AVG(amount_xlm), 0)              AS avg_match_xlm
       FROM donations
       WHERE project_id = $1
         AND transaction_hash LIKE $2`,
      [match.project_id, `match-%-${id}`],
    );

    const stats = statsResult.rows[0];

    return res.json({
      success: true,
      data: {
        matchId: id,
        projectId: match.project_id,
        matcherAddress: match.matcher_address,
        capXLM: match.cap_xlm,
        matchedXLM: match.matched_xlm,
        status: match.status,
        matchTransactions: stats.match_transactions,
        totalMatchedXLM: parseFloat(stats.total_matched || "0").toFixed(7),
        donorsReached: stats.donors_reached,
        avgMatchXLM: parseFloat(stats.avg_match_xlm || "0").toFixed(7),
      },
    });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
