"use strict";

const PgBoss = require("pg-boss");
const pool = require("../db/pool");
const logger = require("../logger");
const { computeBadges } = require("./store");

const QUEUE = "profile-update";
let boss = null;

async function start(io) {
  if (boss) return;

  const connectionString =
    process.env.DATABASE_URL ||
    "postgres://postgres:postgres@localhost:5432/indigopay";

  boss = new PgBoss(connectionString);
  boss.on("error", (err) =>
    logger.error(
      { event: "profile_queue_error", err: err.message },
      "Profile queue pg-boss error",
    ),
  );

  await boss.start();
  await boss.createQueue(QUEUE);

  await boss.work(QUEUE, { teamSize: 2, teamConcurrency: 1 }, async ([job]) => {
    const { donorAddress } = job.data;

    const totalResult = await pool.query(
      `SELECT COALESCE(SUM(amount_xlm), 0)::numeric AS total
       FROM donations
       WHERE donor_address = $1
         AND amount_xlm IS NOT NULL`,
      [donorAddress],
    );

    const totalDonatedXlm = parseFloat(totalResult.rows[0]?.total || "0");

    const projectsSupportedResult = await pool.query(
      `SELECT COUNT(DISTINCT project_id) AS count
       FROM donations
       WHERE donor_address = $1`,
      [donorAddress],
    );

    const projectsSupported = Number.parseInt(
      projectsSupportedResult.rows[0]?.count || "0",
      10,
    );
    const badges = computeBadges(totalDonatedXlm);

    const existingProfileResult = await pool.query(
      "SELECT display_name, bio FROM profiles WHERE public_key = $1",
      [donorAddress],
    );

    const existingProfile = existingProfileResult.rows[0] || {};

    await pool.query(
      `INSERT INTO profiles (
         public_key,
         display_name,
         bio,
         total_donated_xlm,
         projects_supported,
         badges,
         created_at,
         updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW(), NOW())
       ON CONFLICT (public_key) DO UPDATE SET
         total_donated_xlm = EXCLUDED.total_donated_xlm,
         projects_supported = EXCLUDED.projects_supported,
         badges = EXCLUDED.badges,
         updated_at = EXCLUDED.updated_at`,
      [
        donorAddress,
        existingProfile.display_name || null,
        existingProfile.bio || null,
        totalDonatedXlm.toFixed(7),
        projectsSupported,
        JSON.stringify(badges),
      ],
    );

    if (io) {
      io.emit("profile_updated", {
        donorAddress,
        totalDonatedXLM: totalDonatedXlm.toFixed(7),
        projectsSupported,
        badges,
      });
    }
  });
}

async function stop() {
  const currentBoss = boss;
  if (!currentBoss) return;
  boss = null;

  // pg-boss 10 schedules worker removal from `offWork()` but does not await
  // that removal from `stop()`. Keep its client pool open while the polling
  // loops observe the stop signal, then close the pg-boss-owned pool only
  // after those loops have had a chance to exit. Otherwise a late poll calls
  // Node's timers/promises module after Jest has torn the environment down.
  await currentBoss.stop({
    graceful: true,
    close: false,
    timeout: 15_000,
  });
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const db = currentBoss.getDb?.();
  if (db?.opened) await db.close();
}

async function enqueueProfileUpdate(donorAddress) {
  if (!boss) {
    throw new Error("profileQueue not started — call start(io) first");
  }
  return boss.send(QUEUE, { donorAddress }, { retryLimit: 3, retryDelay: 10 });
}

module.exports = { start, stop, enqueueProfileUpdate };
