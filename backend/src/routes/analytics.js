/**
 * src/routes/analytics.js — Project owner impact analytics
 *
 * GET /api/projects/:id/analytics?wallet=Gxxx
 *
 * Returns aggregated donor demographics, time-series donation data,
 * milestone tracking, and cohort retention for a project. Access is
 * restricted to the project's wallet owner.
 *
 * Rate limit: 5 req/min per IP (createRateLimiter).
 */

"use strict";

const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { createRateLimiter } = require("../middleware/rateLimiter");
const { AppError } = require("../errors");

const analyticsLimiter = createRateLimiter(5, 1); // 5 req/min

// ---------------------------------------------------------------------------
// GET /:id/analytics?wallet=Gxxx
// ---------------------------------------------------------------------------

router.get("/:id/analytics", analyticsLimiter, async (req, res, next) => {
  try {
    const projectId = req.params.id;
    const wallet = typeof req.query.wallet === "string" ? req.query.wallet.trim() : "";

    // ── 1. Fetch project + ownership check ──────────────────────────────
    const projectResult = await pool.query(
      "SELECT id, wallet_address, name, goal_xlm, raised_xlm, donor_count, co2_offset_kg, category, location, status, verified FROM projects WHERE id = $1",
      [projectId]
    );
    const project = projectResult.rows[0];
    if (!project) {
      throw new AppError("PROJECT_NOT_FOUND");
    }

    if (!wallet || wallet !== project.wallet_address) {
      throw new AppError("FORBIDDEN", {
        detail: "Only the project owner can view analytics",
      });
    }

    // ── 2. Donor overview ───────────────────────────────────────────────
    const donorOverviewResult = await pool.query(
      `SELECT
         COUNT(DISTINCT donor_address)::int AS total_donors,
         COUNT(DISTINCT CASE WHEN created_at >= NOW() - INTERVAL '30 days' THEN donor_address END)::int AS new_donors_30d,
         ROUND(AVG(amount_xlm)::numeric, 2) AS avg_donation_xlm,
         (SELECT ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY amount_xlm)::numeric, 2)
          FROM donations WHERE project_id = $1) AS median_donation_xlm,
         ROUND(SUM(amount_xlm)::numeric, 2) AS total_raised_xlm,
         COUNT(*)::int AS total_donations
       FROM donations
       WHERE project_id = $1`,
      [projectId]
    );
    const donorOverview = donorOverviewResult.rows[0] || {};

    // ── 3. Top donors ───────────────────────────────────────────────────
    const topDonorsResult = await pool.query(
      `SELECT
         donor_address,
         ROUND(SUM(amount_xlm)::numeric, 2) AS total_contributed,
         COUNT(*)::int AS donation_count,
         MAX(created_at) AS last_donation_at
       FROM donations
       WHERE project_id = $1
       GROUP BY donor_address
       ORDER BY total_contributed DESC
       LIMIT 10`,
      [projectId]
    );

    // ── 4. Daily time series (90 days) ─────────────────────────────────
    const timeSeriesResult = await pool.query(
      `SELECT
         DATE(created_at) AS date,
         ROUND(SUM(amount_xlm)::numeric, 2) AS total,
         COUNT(*)::int AS count
       FROM donations
       WHERE project_id = $1 AND created_at >= NOW() - INTERVAL '90 days'
       GROUP BY DATE(created_at)
       ORDER BY date ASC`,
      [projectId]
    );

    // ── 5. Donation size distribution ──────────────────────────────────
    const distributionResult = await pool.query(
      `SELECT
         CASE
           WHEN amount_xlm < 10 THEN '<10'
           WHEN amount_xlm < 50 THEN '10-50'
           WHEN amount_xlm < 100 THEN '50-100'
           WHEN amount_xlm < 500 THEN '100-500'
           ELSE '500+'
         END AS bucket,
         COUNT(*)::int AS count,
         ROUND(SUM(amount_xlm)::numeric, 2) AS total
       FROM donations
       WHERE project_id = $1
       GROUP BY bucket
       ORDER BY MIN(amount_xlm) ASC`,
      [projectId]
    );

    // ── 6. Donor retention ─────────────────────────────────────────────
    const retentionResult = await pool.query(
      `SELECT
         COUNT(*)::int AS total_donors,
         COUNT(CASE WHEN donation_count > 1 THEN 1 END)::int AS returning_donors,
         CASE WHEN COUNT(*) > 0
           THEN ROUND((COUNT(CASE WHEN donation_count > 1 THEN 1 END)::numeric / COUNT(*)::numeric) * 100, 1)
           ELSE 0
         END AS retention_pct
       FROM (
         SELECT donor_address, COUNT(*) AS donation_count
         FROM donations
         WHERE project_id = $1
         GROUP BY donor_address
       ) sub`,
      [projectId]
    );
    const retentionPct = parseFloat(retentionResult.rows[0]?.retention_pct || "0");

    // ── 7. Milestone progress ──────────────────────────────────────────
    const milestonesResult = await pool.query(
      "SELECT id, title, percentage, reached_at, transaction_hash FROM project_milestones WHERE project_id = $1 ORDER BY percentage ASC",
      [projectId]
    );

    // ── 8. Campaign performance ────────────────────────────────────────
    const campaignsResult = await pool.query(
      "SELECT id, title, goal_xlm, deadline, created_at FROM project_campaigns WHERE project_id = $1 ORDER BY created_at DESC",
      [projectId]
    );

    // ── 9. Rating summary ──────────────────────────────────────────────
    const ratingResult = await pool.query(
      `SELECT
         ROUND(AVG(rating)::numeric, 1) AS average_rating,
         COUNT(*)::int AS total_ratings,
         COUNT(CASE WHEN rating = 1 THEN 1 END)::int AS star_1,
         COUNT(CASE WHEN rating = 2 THEN 1 END)::int AS star_2,
         COUNT(CASE WHEN rating = 3 THEN 1 END)::int AS star_3,
         COUNT(CASE WHEN rating = 4 THEN 1 END)::int AS star_4,
         COUNT(CASE WHEN rating = 5 THEN 1 END)::int AS star_5
       FROM project_ratings
       WHERE project_id = $1`,
      [projectId]
    );

    // ── 10. Compute campaign progress ──────────────────────────────────
    const campaigns = await Promise.all(
      campaignsResult.rows.map(async (campaign) => {
        const progressResult = await pool.query(
          `SELECT COALESCE(SUM(amount_xlm), 0)::numeric AS raised
           FROM donations
           WHERE project_id = $1 AND created_at >= $2 AND created_at <= $3`,
          [projectId, campaign.created_at, campaign.deadline]
        );
        const raised = parseFloat(progressResult.rows[0].raised || "0");
        const goal = parseFloat(campaign.goal_xlm || "0");
        const progressPercent = goal > 0 ? Math.min(Math.round((raised / goal) * 100), 100) : 0;
        const completed = progressPercent >= 100 || new Date(campaign.deadline) < new Date();
        return {
          id: campaign.id,
          title: campaign.title,
          goalXLM: campaign.goal_xlm?.toString() || "0",
          raisedXLM: raised.toFixed(2),
          deadline: new Date(campaign.deadline).toISOString(),
          progressPercent,
          status: completed ? (progressPercent >= 100 ? "completed" : "ended") : "active",
        };
      })
    );

    // ── 11. Assemble response ──────────────────────────────────────────
    res.json({
      success: true,
      data: {
        projectId,
        projectName: project.name,
        donorOverview: {
          totalDonors: donorOverview.total_donors || 0,
          newDonors30d: donorOverview.new_donors_30d || 0,
          avgDonationXLM: donorOverview.avg_donation_xlm || "0",
          medianDonationXLM: donorOverview.median_donation_xlm || "0",
          totalRaisedXLM: donorOverview.total_raised_xlm || "0",
          totalDonations: donorOverview.total_donations || 0,
        },
        topDonors: topDonorsResult.rows.map((row) => ({
          donorAddress: row.donor_address,
          totalContributed: row.total_contributed?.toString() || "0",
          donationCount: row.donation_count,
          lastDonationAt: row.last_donation_at ? new Date(row.last_donation_at).toISOString() : null,
        })),
        donationTimeline: timeSeriesResult.rows.map((row) => ({
          date: row.date instanceof Date ? row.date.toISOString().slice(0, 10) : String(row.date).slice(0, 10),
          total: row.total?.toString() || "0",
          count: row.count,
        })),
        donationDistribution: distributionResult.rows.map((row) => ({
          bucket: row.bucket,
          count: row.count,
          total: row.total?.toString() || "0",
        })),
        donorRetention: {
          totalDonors: retentionResult.rows[0]?.total_donors || 0,
          returningDonors: retentionResult.rows[0]?.returning_donors || 0,
          oneTimeDonors: (retentionResult.rows[0]?.total_donors || 0) - (retentionResult.rows[0]?.returning_donors || 0),
          retentionPct,
        },
        milestones: milestonesResult.rows.map((row) => {
          const goalXLM = parseFloat(project.goal_xlm || "0");
          const raisedXLM = parseFloat(project.raised_xlm || "0");
          const milestoneTarget = goalXLM * (row.percentage / 100);
          const currentProgress = goalXLM > 0 ? Math.min(Math.round((raisedXLM / milestoneTarget) * 100), 100) : 0;
          return {
            id: row.id,
            title: row.title,
            percentage: row.percentage,
            reached: Boolean(row.reached_at),
            reachedAt: row.reached_at ? new Date(row.reached_at).toISOString() : null,
            transactionHash: row.transaction_hash || null,
            currentProgress,
          };
        }),
        campaigns,
        ratingSummary: {
          averageRating: parseFloat(ratingResult.rows[0]?.average_rating || "0"),
          totalRatings: ratingResult.rows[0]?.total_ratings || 0,
          distribution: {
            1: ratingResult.rows[0]?.star_1 || 0,
            2: ratingResult.rows[0]?.star_2 || 0,
            3: ratingResult.rows[0]?.star_3 || 0,
            4: ratingResult.rows[0]?.star_4 || 0,
            5: ratingResult.rows[0]?.star_5 || 0,
          },
        },
      },
    });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
