"use strict";

/**
 * backend/src/services/analyticsService.js
 *
 * Admin analytics service providing aggregated donation trends,
 * project performance, geographic impact, donor retention, category
 * breakdown, and platform growth metrics for the admin dashboard.
 *
 * Each function accepts optional { from, to } Date params to scope
 * queries to a time range.
 */

const pool = require("../db/pool");

// -- Helpers ----------------------------------------------------------

function dateClause(from, to, column = "created_at") {
  const clauses = [];
  const values = [];
  if (from) {
    values.push(from);
    clauses.push(`${column} >= $${values.length}`);
  }
  if (to) {
    values.push(to);
    clauses.push(`${column} <= $${values.length}`);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", values };
}

// -- Exports ----------------------------------------------------------

/**
 * Daily donation totals over time for trend charts.
 * @param {{ from?: Date|string, to?: Date|string }} [range]
 * @returns {Promise<Array<{ day: string, donationCount: number, totalXLM: string, uniqueDonors: number, avgDonationXLM: string }>>}
 */
async function getDonationTrends(range = {}) {
  const { where, values } = dateClause(range.from, range.to, "day");

  // Refresh the materialized view first for fresh data
  try {
    await pool.query("REFRESH MATERIALIZED VIEW CONCURRENTLY mv_daily_donations");
  } catch {
    // If concurrent refresh isn't supported, try non-concurrent
    try {
      await pool.query("REFRESH MATERIALIZED VIEW mv_daily_donations");
    } catch {
      // View may not exist — fall back to direct query
    }
  }

  const result = await pool.query(
    `SELECT day, donation_count AS "donationCount",
            total_xlm AS "totalXLM", unique_donors AS "uniqueDonors",
            avg_donation_xlm AS "avgDonationXLM"
     FROM mv_daily_donations
     ${where}
     ORDER BY day ASC`,
    values,
  );

  return result.rows.map((r) => ({
    day: r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day).slice(0, 10),
    donationCount: r.donationCount,
    totalXLM: String(r.totalXLM || "0"),
    uniqueDonors: r.uniqueDonors,
    avgDonationXLM: String(r.avgDonationXLM || "0"),
  }));
}

/**
 * Project performance metrics sorted by raised amount.
 * @param {{ from?: Date|string, to?: Date|string }} [range]
 * @returns {Promise<Array>}
 */
async function getProjectPerformance(range = {}) {
  try {
    await pool.query("REFRESH MATERIALIZED VIEW mv_project_performance");
  } catch { /* fallback */ }

  const result = await pool.query(
    `SELECT id, name, category, location, raised_xlm AS "raisedXLM",
            donor_count AS "donorCount", goal_xlm AS "goalXLM",
            co2_offset_kg AS "co2OffsetKg", status, verified,
            progress_pct AS "progressPct", total_donations AS "totalDonations",
            last_donation_at AS "lastDonationAt",
            created_at AS "createdAt"
     FROM mv_project_performance
     ORDER BY raised_xlm DESC
     LIMIT 100`,
  );

  return result.rows.map((r) => ({
    id: r.id,
    name: r.name,
    category: r.category,
    location: r.location,
    raisedXLM: String(r.raisedXLM || "0"),
    donorCount: r.donorCount,
    goalXLM: String(r.goalXLM || "0"),
    co2OffsetKg: r.co2OffsetKg,
    status: r.status,
    verified: r.verified,
    progressPct: Number(r.progressPct || 0),
    totalDonations: r.totalDonations,
    lastDonationAt: r.lastDonationAt ? new Date(r.lastDonationAt).toISOString() : null,
    createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null,
  }));
}

/**
 * Geographic impact distribution by country.
 * @returns {Promise<Array>}
 */
async function getGeographicImpact() {
  try {
    await pool.query("REFRESH MATERIALIZED VIEW mv_geographic_impact");
  } catch { /* fallback */ }

  const result = await pool.query(
    `SELECT country, project_count AS "projectCount", total_xlm AS "totalXLM",
            donor_count AS "donorCount", total_co2_kg AS "totalCO2Kg"
     FROM mv_geographic_impact
     ORDER BY total_xlm DESC`,
  );

  return result.rows.map((r) => ({
    country: r.country,
    projectCount: r.projectCount,
    totalXLM: String(r.totalXLM || "0"),
    donorCount: r.donorCount,
    totalCO2Kg: r.totalCO2Kg,
  }));
}

/**
 * Donor retention cohorts (monthly).
 * @returns {Promise<Array>}
 */
async function getDonorRetention() {
  try {
    await pool.query("REFRESH MATERIALIZED VIEW mv_donor_cohorts");
  } catch { /* fallback */ }

  const result = await pool.query(
    `SELECT cohort_month AS "cohortMonth", cohort_size AS "cohortSize",
            activity_month AS "activityMonth", active_donors AS "activeDonors",
            retention_pct AS "retentionPct"
     FROM mv_donor_cohorts
     ORDER BY cohort_month DESC, activity_month ASC
     LIMIT 200`,
  );

  return result.rows.map((r) => ({
    cohortMonth: r.cohortMonth instanceof Date ? r.cohortMonth.toISOString().slice(0, 7) : String(r.cohortMonth).slice(0, 7),
    cohortSize: r.cohortSize,
    activityMonth: r.activityMonth instanceof Date ? r.activityMonth.toISOString().slice(0, 7) : String(r.activityMonth).slice(0, 7),
    activeDonors: r.activeDonors,
    retentionPct: Number(r.retentionPct || 0),
  }));
}

/**
 * Category breakdown — donations by project category.
 * @param {{ from?: Date|string, to?: Date|string }} [range]
 * @returns {Promise<Array>}
 */
async function getCategoryBreakdown(range = {}) {
  const { where, values } = dateClause(range.from, range.to, "d.created_at");
  const whereClause = where ? `${where} AND p.status = 'active'` : "WHERE p.status = 'active'";

  const result = await pool.query(
    `SELECT p.category,
            COUNT(DISTINCT d.id)::int AS "donationCount",
            COALESCE(SUM(d.amount_xlm), 0) AS "totalXLM",
            COUNT(DISTINCT d.donor_address)::int AS "donorCount"
     FROM donations d
     JOIN projects p ON p.id = d.project_id
     ${whereClause}
     GROUP BY p.category
     ORDER BY "totalXLM" DESC`,
    values,
  );

  return result.rows.map((r) => ({
    category: r.category,
    donationCount: r.donationCount,
    totalXLM: String(r.totalXLM || "0"),
    donorCount: r.donorCount,
  }));
}

/**
 * Platform growth metrics — cumulative and monthly totals.
 * @returns {Promise<object>}
 */
async function getPlatformGrowth() {
  const [summary, monthly] = await Promise.all([
    pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM projects) AS "totalProjects",
         (SELECT COUNT(*)::int FROM donations) AS "totalDonations",
         (SELECT COUNT(DISTINCT donor_address)::int FROM donations) AS "totalDonors",
         (SELECT COALESCE(SUM(amount_xlm), 0) FROM donations) AS "totalXLM",
         (SELECT COUNT(DISTINCT donor_address)::int
          FROM donations
          WHERE created_at >= NOW() - INTERVAL '30 days') AS "activeDonors30d",
         (SELECT COALESCE(SUM(amount_xlm), 0)
          FROM donations
          WHERE created_at >= NOW() - INTERVAL '30 days') AS "totalXLM30d"
       FROM (VALUES (1)) t`,
    ),
    pool.query(
      `SELECT
         DATE_TRUNC('month', created_at)::date AS "month",
         COUNT(*)::int AS "donations",
         COALESCE(SUM(amount_xlm), 0) AS "totalXLM",
         COUNT(DISTINCT donor_address)::int AS "donors"
       FROM donations
       GROUP BY DATE_TRUNC('month', created_at)
       ORDER BY "month" ASC`,
    ),
  ]);

  const s = summary.rows[0];
  return {
    summary: {
      totalProjects: Number(s.totalProjects),
      totalDonations: Number(s.totalDonations),
      totalDonors: Number(s.totalDonors),
      totalXLM: String(s.totalXLM || "0"),
      activeDonors30d: Number(s.activeDonors30d),
      totalXLM30d: String(s.totalXLM30d || "0"),
    },
    monthlyGrowth: monthly.rows.map((r) => ({
      month: r.month instanceof Date ? r.month.toISOString().slice(0, 7) : String(r.month).slice(0, 7),
      donations: Number(r.donations),
      totalXLM: String(r.totalXLM || "0"),
      donors: Number(r.donors),
    })),
  };
}

module.exports = {
  getDonationTrends,
  getProjectPerformance,
  getGeographicImpact,
  getDonorRetention,
  getCategoryBreakdown,
  getPlatformGrowth,
};
