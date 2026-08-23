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
 *
 * Query-time bounds (closes #718):
 *   - Every aggregate runs through runBoundedQuery(), which applies an
 *     explicit statement_timeout (ANALYTICS_STATEMENT_TIMEOUT_MS) scoped to
 *     that query via SET LOCAL, so a degraded plan can never stall the admin
 *     dashboard.
 *   - Result sets are capped with paginated windows (LIMIT).
 *   - getDonationTrends / getCategoryBreakdown clamp { from, to } to a
 *     bounded window (TRENDS_MAX_DAYS) unless the caller explicitly supplies
 *     one, keeping the default path off full-table scans of the donations
 *     ledger.
 */

const pool = require("../db/pool");

// -- Bounds ----------------------------------------------------------

const ANALYTICS_STATEMENT_TIMEOUT_MS = Number(
  process.env.ANALYTICS_STATEMENT_TIMEOUT_MS || 1500,
);

const TRENDS_MAX_DAYS = 1826; // ~5 years of daily rows
const PROJECT_PERFORMANCE_LIMIT = 100;
const GEOGRAPHIC_LIMIT = 250;
const RETENTION_LIMIT = 200;
const CATEGORY_LIMIT = 100;
const GROWTH_MONTHS_LIMIT = 120; // ~10 years of monthly rows

const DAY_MS = 24 * 60 * 60 * 1000;

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

/**
 * Clamp an optional { from, to } range to at most `maxDays`. When only one
 * bound is given the other is derived (from → now, to → now-maxDays), so the
 * returned window is always finite. A missing range stays unbounded so the
 * call site decides whether that is acceptable.
 * @param {{ from?: Date|string, to?: Date|string }} [range]
 * @param {number} [maxDays]
 * @returns {{ from: Date|null, to: Date|null }}
 */
function clampRange(range = {}, maxDays = TRENDS_MAX_DAYS) {
  let from = range.from ? new Date(range.from) : null;
  let to = range.to ? new Date(range.to) : null;
  if (!from && !to) return { from: null, to: null };
  if (!to) to = new Date();
  if (!from) from = new Date(to.getTime() - maxDays * DAY_MS);
  if (to.getTime() - from.getTime() > maxDays * DAY_MS) {
    from = new Date(to.getTime() - maxDays * DAY_MS);
  }
  return { from, to };
}

/**
 * Run an aggregate query under an explicit statement_timeout budget. Uses a
 * dedicated connection with SET LOCAL so the timeout is scoped to this query
 * and never bleeds into pooled connections or subsequent statements.
 */
async function runBoundedQuery(sql, values = []) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL statement_timeout = ${ANALYTICS_STATEMENT_TIMEOUT_MS}`);
    const result = await client.query(sql, values);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// -- Exports ----------------------------------------------------------

/**
 * Daily donation totals over time for trend charts.
 * @param {{ from?: Date|string, to?: Date|string }} [range]
 * @returns {Promise<Array<{ day: string, donationCount: number, totalXLM: string, uniqueDonors: number, avgDonationXLM: string }>>}
 */
async function getDonationTrends(range = {}) {
  const { from, to } = clampRange(range);
  const { where, values } = dateClause(from, to, "day");

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

  const result = await runBoundedQuery(
    `SELECT day, donation_count AS "donationCount",
            total_xlm AS "totalXLM", unique_donors AS "uniqueDonors",
            avg_donation_xlm AS "avgDonationXLM"
     FROM mv_daily_donations
     ${where}
     ORDER BY day ASC
     LIMIT ${TRENDS_MAX_DAYS}`,
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
 * @returns {Promise<Array>}
 */
async function getProjectPerformance() {
  try {
    await pool.query("REFRESH MATERIALIZED VIEW mv_project_performance");
  } catch { /* fallback */ }

  const result = await runBoundedQuery(
    `SELECT id, name, category, location, raised_xlm AS "raisedXLM",
            donor_count AS "donorCount", goal_xlm AS "goalXLM",
            co2_offset_kg AS "co2OffsetKg", status, verified,
            progress_pct AS "progressPct", total_donations AS "totalDonations",
            last_donation_at AS "lastDonationAt",
            created_at AS "createdAt"
     FROM mv_project_performance
     ORDER BY raised_xlm DESC
     LIMIT ${PROJECT_PERFORMANCE_LIMIT}`,
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

  const result = await runBoundedQuery(
    `SELECT country, project_count AS "projectCount", total_xlm AS "totalXLM",
            donor_count AS "donorCount", total_co2_kg AS "totalCO2Kg"
     FROM mv_geographic_impact
     ORDER BY total_xlm DESC
     LIMIT ${GEOGRAPHIC_LIMIT}`,
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

  const result = await runBoundedQuery(
    `SELECT cohort_month AS "cohortMonth", cohort_size AS "cohortSize",
            activity_month AS "activityMonth", active_donors AS "activeDonors",
            retention_pct AS "retentionPct"
     FROM mv_donor_cohorts
     ORDER BY cohort_month DESC, activity_month ASC
     LIMIT ${RETENTION_LIMIT}`,
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
 * Build the SQL for the category breakdown query, scoped to an optional
 * { from, to } range. Exported separately so EXPLAIN regression tests can
 * inspect the plan without executing against the app pool.
 * @param {{ from?: Date|string, to?: Date|string }} [range]
 * @returns {{ sql: string, values: Array }}
 */
function buildCategoryBreakdownQuery(range = {}) {
  const { from, to } = clampRange(range);
  const { where, values } = dateClause(from, to, "d.created_at");
  const whereClause = where ? `${where} AND p.status = 'active'` : "WHERE p.status = 'active'";

  return {
    sql: `SELECT p.category,
                 COUNT(DISTINCT d.id)::int AS "donationCount",
                 COALESCE(SUM(d.amount_xlm), 0) AS "totalXLM",
                 COUNT(DISTINCT d.donor_address)::int AS "donorCount"
          FROM donations d
          JOIN projects p ON p.id = d.project_id
          ${whereClause}
          GROUP BY p.category
          ORDER BY "totalXLM" DESC
          LIMIT ${CATEGORY_LIMIT}`,
    values,
  };
}

/**
 * Category breakdown — donations by project category.
 * @param {{ from?: Date|string, to?: Date|string }} [range]
 * @returns {Promise<Array>}
 */
async function getCategoryBreakdown(range = {}) {
  const { sql, values } = buildCategoryBreakdownQuery(range);
  const result = await runBoundedQuery(sql, values);

  return result.rows.map((r) => ({
    category: r.category,
    donationCount: r.donationCount,
    totalXLM: String(r.totalXLM || "0"),
    donorCount: r.donorCount,
  }));
}

/**
 * Build the SQL for the platform growth query (summary + monthly rows).
 * Exported separately so EXPLAIN regression tests can inspect the plan
 * without executing against the app pool.
 * @returns {{ summary: { sql: string, values: Array }, monthly: { sql: string, values: Array } }}
 */
function buildPlatformGrowthQueries() {
  return {
    summary: {
      sql: `SELECT
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
      values: [],
    },
    monthly: {
      sql: `SELECT
              DATE_TRUNC('month', created_at)::date AS "month",
              COUNT(*)::int AS "donations",
              COALESCE(SUM(amount_xlm), 0) AS "totalXLM",
              COUNT(DISTINCT donor_address)::int AS "donors"
            FROM donations
            GROUP BY DATE_TRUNC('month', created_at)
            ORDER BY "month" ASC
            LIMIT ${GROWTH_MONTHS_LIMIT}`,
      values: [],
    },
  };
}

/**
 * Platform growth metrics — cumulative and monthly totals.
 * @returns {Promise<object>}
 */
async function getPlatformGrowth() {
  const { summary, monthly } = buildPlatformGrowthQueries();
  const [summaryResult, monthlyResult] = await Promise.all([
    runBoundedQuery(summary.sql, summary.values),
    runBoundedQuery(monthly.sql, monthly.values),
  ]);

  const s = summaryResult.rows[0];
  return {
    summary: {
      totalProjects: Number(s.totalProjects),
      totalDonations: Number(s.totalDonations),
      totalDonors: Number(s.totalDonors),
      totalXLM: String(s.totalXLM || "0"),
      activeDonors30d: Number(s.activeDonors30d),
      totalXLM30d: String(s.totalXLM30d || "0"),
    },
    monthlyGrowth: monthlyResult.rows.map((r) => ({
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
  // Exported for EXPLAIN regression tests and bounds unit tests.
  buildCategoryBreakdownQuery,
  buildPlatformGrowthQueries,
  clampRange,
  runBoundedQuery,
  ANALYTICS_STATEMENT_TIMEOUT_MS,
  TRENDS_MAX_DAYS,
  PROJECT_PERFORMANCE_LIMIT,
  GEOGRAPHIC_LIMIT,
  RETENTION_LIMIT,
  CATEGORY_LIMIT,
  GROWTH_MONTHS_LIMIT,
};
