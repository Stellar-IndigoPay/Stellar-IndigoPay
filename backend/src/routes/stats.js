/**
 * src/routes/stats.js
 * GET /api/stats/global — landing-page aggregate platform totals.
 */
"use strict";
const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { cacheResponse } = require("../middleware/cache");

const GLOBAL_STATS_CACHE_KEY = "cache:v1:stats:global";
const GLOBAL_STATS_CACHE_TTL_SECONDS = 300;

function mapGlobalStatsRow(row = {}) {
  return {
    totalXLMRaised: Number.parseFloat(row.totalXLMRaised || "0").toFixed(7),
    totalCO2OffsetKg: Number.parseInt(row.totalCO2OffsetKg, 10) || 0,
    totalDonations: Number.parseInt(row.totalDonations, 10) || 0,
    totalProjects: Number.parseInt(row.totalProjects, 10) || 0,
    totalDonors: Number.parseInt(row.totalDonors, 10) || 0,
  };
}

// GET /api/stats/global
router.get("/global", cacheResponse(300, () => GLOBAL_STATS_CACHE_KEY), async (req, res, next) => {
  try {
    const result = await pool.query(`
      WITH project_totals AS (
        SELECT
          COALESCE(SUM(raised_xlm), 0)      AS total_xlm_raised,
          COALESCE(SUM(co2_offset_kg), 0)::int AS total_co2_offset_kg,
          COUNT(*)::int                    AS total_projects,
          COALESCE(SUM(donor_count), 0)::int AS total_donors
        FROM projects
      ),
      donation_totals AS (
        SELECT
          COUNT(*)::int AS total_donations
        FROM donations
      )
      SELECT
        p.total_xlm_raised     AS "totalXLMRaised",
        p.total_co2_offset_kg  AS "totalCO2OffsetKg",
        d.total_donations      AS "totalDonations",
        p.total_projects       AS "totalProjects",
        p.total_donors         AS "totalDonors"
      FROM project_totals p
      CROSS JOIN donation_totals d
    `);

    const stats = mapGlobalStatsRow(result.rows[0]);
    res.json(stats);
  } catch (e) {
    next(e);
  }
});

// GET /api/stats/categories — project count per category
router.get("/categories", async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT
        category,
        COUNT(*)::int AS count
      FROM projects
      WHERE status = 'active'
      GROUP BY category
      ORDER BY count DESC, category ASC
    `);

    res.json({
      success: true,
      data: result.rows,
    });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
module.exports.GLOBAL_STATS_CACHE_KEY = GLOBAL_STATS_CACHE_KEY;
module.exports.GLOBAL_STATS_CACHE_TTL_SECONDS = GLOBAL_STATS_CACHE_TTL_SECONDS;
module.exports.mapGlobalStatsRow = mapGlobalStatsRow;
