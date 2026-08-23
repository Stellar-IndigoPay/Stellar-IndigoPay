"use strict";

/**
 * 030_analytics_time_range_indexes.js
 *
 * Issue #718 — bound and index admin analytics aggregates.
 *
 * The category breakdown and platform-growth 30-day window queries filter
 * the donations ledger by created_at (with no project_id predicate). The
 * existing idx_donations_project_created index can only serve lookups that
 * anchor on project_id, so a standalone created_at index keeps those time
 * ranges cheap and lets the planner avoid sequential scans of donations.
 * DESC matches the ordering used by migration 002 and the trend charts.
 */

module.exports = {
  name: "030_analytics_time_range_indexes",

  async up(client) {
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_donations_created_at
      ON donations (created_at DESC)
    `);
  },

  async down(client) {
    await client.query("DROP INDEX IF EXISTS idx_donations_created_at");
  },
};
