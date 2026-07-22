"use strict";

const PgBoss = require("pg-boss");
const pool = require("../db/pool");
const { get: redisGet, set: redisSet } = require("./redis");
const { computeBadges } = require("./store"); // reuse badge computation if needed

const QUEUE = "impact-recalculation";
let boss = null;

/**
 * Start the pg‑boss scheduler and register the impact‑recalculation worker.
 * Must be called after migrations and before the HTTP server starts.
 */
async function start(io) {
  const connectionString =
    process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/indigopay";

  boss = new PgBoss(connectionString);
  boss.on("error", (err) => console.error("[impactQueue] pg-boss error:", err.message));

  await boss.start();

  // teamSize 1 as per requirement
  await boss.work(QUEUE, { teamSize: 1, teamConcurrency: 1 }, async (job) => {
    const { donationId, projectId, donorAddress, amountXLM } = job.data;

    // Idempotency: check log – if already completed, skip
    const logRes = await pool.query(
      "SELECT status FROM impact_recalculation_log WHERE donation_id = $1",
      [donationId]
    );
    if (logRes.rows[0] && logRes.rows[0].status === "completed") {
      return; // already processed
    }

    // Mark as processing
    await pool.query(
      `INSERT INTO impact_recalculation_log (donation_id, project_id, status)
       VALUES ($1, $2, 'processing')
       ON CONFLICT (donation_id) DO UPDATE SET status = 'processing'`,
      [donationId, projectId]
    );

    try {
      // ----- Update donor_impact -----
      // Aggregate donor totals (donated XLM, CO2, trees, projects)
      const donorAgg = await pool.query(
        `SELECT
           COALESCE(SUM(d.amount_xlm), 0) AS total_donated_xlm,
           COALESCE(SUM(
             CASE WHEN p.raised_xlm > 0 THEN d.amount_xlm * (p.co2_offset_kg::numeric / p.raised_xlm)
                  ELSE 0 END), 0) AS total_co2_kg,
           COUNT(DISTINCT d.project_id) AS projects_supported
         FROM donations d
         JOIN projects p ON p.id = d.project_id
         WHERE d.donor_address = $1`,
        [donorAddress]
      );
      const donorRow = donorAgg.rows[0];
      const totalDonatedXlm = parseFloat(donorRow.total_donated_xlm);
      const totalCo2Kg = parseFloat(donorRow.total_co2_kg);
      const totalTrees = parseFloat((totalCo2Kg / 21.77).toFixed(2)); // same heuristic as route
      const projectsSupported = parseInt(donorRow.projects_supported, 10);
      const badges = computeBadges(totalDonatedXlm);
      const badgeTier = badges.length > 0 ? badges[0] : null; // simple example

      await pool.query(
        `INSERT INTO donor_impact (wallet_address, total_donated_xlm, total_co2_kg, total_trees, projects_supported, badge_tier, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (wallet_address) DO UPDATE SET
           total_donated_xlm = EXCLUDED.total_donated_xlm,
           total_co2_kg = EXCLUDED.total_co2_kg,
           total_trees = EXCLUDED.total_trees,
           projects_supported = EXCLUDED.projects_supported,
           badge_tier = EXCLUDED.badge_tier,
           updated_at = EXCLUDED.updated_at`,
        [donorAddress, totalDonatedXlm, totalCo2Kg, totalTrees, projectsSupported, badgeTier]
      );

      // ----- Update global_impact -----
      const globalAgg = await pool.query(
        `SELECT
           COALESCE(SUM(d.amount_xlm), 0) AS total_donated_xlm,
           COUNT(*) AS total_donations,
           COUNT(DISTINCT d.donor_address) AS total_donors,
           COUNT(DISTINCT d.project_id) AS total_projects,
           COALESCE(SUM(
             CASE WHEN p.raised_xlm > 0 THEN d.amount_xlm * (p.co2_offset_kg::numeric / p.raised_xlm)
                  ELSE 0 END), 0) AS total_co2_kg
         FROM donations d
         JOIN projects p ON p.id = d.project_id`,
        []
      );
      const g = globalAgg.rows[0];
      const totalDonated = parseFloat(g.total_donated_xlm);
      const totalDonations = parseInt(g.total_donations, 10);
      const totalDonors = parseInt(g.total_donors, 10);
      const totalProjects = parseInt(g.total_projects, 10);
      const totalCo2 = parseFloat(g.total_co2_kg);
      const totalTreesGlobal = parseFloat((totalCo2 / 21.77).toFixed(2));

      await pool.query(
        `UPDATE global_impact SET
           total_donated_xlm = $1,
           total_co2_kg = $2,
           total_trees = $3,
           total_donations = $4,
           total_projects = $5,
           total_donors = $6,
           updated_at = NOW()
         WHERE id = 1`,
        [totalDonated, totalCo2, totalTreesGlobal, totalDonations, totalProjects, totalDonors]
      );

      // ----- Refresh Redis cache for global impact -----
      const cacheKey = "impact:global";
      await redisSet(cacheKey, {
        totalDonatedXLM: totalDonated.toFixed(7),
        totalCo2Kg: Math.round(totalCo2),
        totalTrees: Math.round(totalTreesGlobal),
        totalDonations,
        totalProjects,
        totalDonors,
      }, 300); // 5 minutes TTL

      // Mark log as completed
      await pool.query(
        "UPDATE impact_recalculation_log SET status = 'completed', error = NULL WHERE donation_id = $1",
        [donationId]
      );

      if (io && typeof io.emit === "function") {
        io.emit("impact_updated", { donorAddress, projectId, donationId });
      }
    } catch (err) {
      // Record failure
      await pool.query(
        "UPDATE impact_recalculation_log SET status = 'failed', error = $1 WHERE donation_id = $2",
        [err.message, donationId]
      );
      throw err; // let pg‑boss retry per its config
    }
  });

  console.log("[impactQueue] pg‑boss started, worker registered on queue:", QUEUE);
}

/** Enqueue a background impact recalculation after a donation is persisted. */
async function enqueueImpactRecalc({ donationId, projectId, donorAddress, amountXLM }) {
  if (!boss) {
    throw new Error("impactQueue not started — call start(io) first");
  }
  return boss.send(
    QUEUE,
    { donationId, projectId, donorAddress, amountXLM },
    { retryLimit: 3, retryDelay: 10 }
  );
}

module.exports = { start, enqueueImpactRecalc };
