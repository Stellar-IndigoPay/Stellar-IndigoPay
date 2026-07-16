"use strict";

module.exports = {
  name: "016_analytics_views",

  async up(client) {
    // ── Daily donation aggregations ────────────────────────────────────────
    await client.query(`
      CREATE MATERIALIZED VIEW IF NOT EXISTS mv_daily_donations AS
      SELECT
        DATE(created_at) AS day,
        COUNT(*)::int AS donation_count,
        SUM(amount_xlm) AS total_xlm,
        COUNT(DISTINCT donor_address)::int AS unique_donors,
        ROUND(AVG(amount_xlm)::numeric, 2) AS avg_donation_xlm
      FROM donations
      GROUP BY DATE(created_at)
      ORDER BY day DESC
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_daily_donations_day
      ON mv_daily_donations(day)
    `);

    // ── Project performance metrics ────────────────────────────────────────
    await client.query(`
      CREATE MATERIALIZED VIEW IF NOT EXISTS mv_project_performance AS
      SELECT
        p.id,
        p.name,
        p.category,
        p.location,
        p.raised_xlm,
        p.donor_count,
        p.goal_xlm,
        p.co2_offset_kg,
        p.status,
        p.verified,
        p.created_at,
        ROUND(
          CASE WHEN p.goal_xlm > 0
            THEN (p.raised_xlm / p.goal_xlm * 100)::numeric
            ELSE 0
          END, 1
        ) AS progress_pct,
        COALESCE(d.donation_count, 0) AS total_donations,
        COALESCE(d.last_donation, NULL) AS last_donation_at
      FROM projects p
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*) AS donation_count,
          MAX(created_at) AS last_donation
        FROM donations
        WHERE project_id = p.id
      ) d ON true
      ORDER BY p.raised_xlm DESC
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_project_performance_id
      ON mv_project_performance(id)
    `);

    // ── Geographic impact distribution ─────────────────────────────────────
    await client.query(`
      CREATE MATERIALIZED VIEW IF NOT EXISTS mv_geographic_impact AS
      SELECT
        p.location AS country,
        COUNT(DISTINCT p.id)::int AS project_count,
        COALESCE(SUM(donations.amount_xlm), 0) AS total_xlm,
        COUNT(DISTINCT donations.donor_address)::int AS donor_count,
        COALESCE(
          (SELECT SUM(inner_p.co2_offset_kg)
           FROM projects inner_p
           WHERE inner_p.location = p.location AND inner_p.status = 'active'),
          0
        ) AS total_co2_kg
      FROM projects p
      LEFT JOIN donations ON donations.project_id = p.id
      WHERE p.status = 'active'
      GROUP BY p.location
      ORDER BY total_xlm DESC
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_geographic_impact_country
      ON mv_geographic_impact(country)
    `);

    // ── Donor cohort retention ─────────────────────────────────────────────
    await client.query(`
      CREATE MATERIALIZED VIEW IF NOT EXISTS mv_donor_cohorts AS
      WITH donor_first AS (
        SELECT
          donor_address,
          MIN(DATE_TRUNC('month', created_at)) AS cohort_month
        FROM donations
        GROUP BY donor_address
      ),
      donor_activity AS (
        SELECT DISTINCT
          donor_address,
          DATE_TRUNC('month', created_at) AS activity_month
        FROM donations
      )
      SELECT
        df.cohort_month,
        COUNT(DISTINCT df.donor_address)::int AS cohort_size,
        da.activity_month,
        COUNT(DISTINCT da.donor_address)::int AS active_donors,
        ROUND(
          (COUNT(DISTINCT da.donor_address)::numeric /
           NULLIF(COUNT(DISTINCT df.donor_address)::numeric, 0) * 100), 1
        ) AS retention_pct
      FROM donor_first df
      LEFT JOIN donor_activity da
        ON df.donor_address = da.donor_address
        AND da.activity_month >= df.cohort_month
      GROUP BY df.cohort_month, da.activity_month
      ORDER BY df.cohort_month DESC, da.activity_month ASC
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_donor_cohorts_month
      ON mv_donor_cohorts(cohort_month, activity_month)
    `);
  },

  async down(client) {
    await client.query(`DROP MATERIALIZED VIEW IF EXISTS mv_donor_cohorts CASCADE`);
    await client.query(`DROP MATERIALIZED VIEW IF EXISTS mv_geographic_impact CASCADE`);
    await client.query(`DROP MATERIALIZED VIEW IF EXISTS mv_project_performance CASCADE`);
    await client.query(`DROP MATERIALIZED VIEW IF EXISTS mv_daily_donations CASCADE`);
  },
};
