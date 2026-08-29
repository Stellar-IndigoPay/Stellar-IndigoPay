"use strict";

/**
 * src/services/matchQueue.js
 *
 * pg-boss job queue for asynchronous donation matching.
 *
 * Previously donation matching was done inline inside `recordDonation()` in
 * routes/donations.js.  Moving it to a background worker means:
 *   1. The POST /api/donations endpoint returns faster (no matching queries).
 *   2. Matching failures don't roll back the donation itself.
 *   3. Retries with backoff handle transient DB / network issues.
 */

const PgBoss = require("pg-boss");
const pool = require("../db/pool");
const logger = require("../logger");
const { v4: uuid } = require("uuid");

const QUEUE = "donation-match";

let boss = null;

async function start() {
  if (boss) return;

  const connectionString =
    process.env.DATABASE_URL ||
    "postgres://postgres:postgres@localhost:5432/indigopay";

  boss = new PgBoss(connectionString);
  boss.on("error", (err) =>
    logger.error(
      { event: "match_queue_error", err: err.message },
      "Match queue pg-boss error",
    ),
  );

  await boss.start();
  await boss.createQueue(QUEUE);

  await boss.work(QUEUE, { teamSize: 2, teamConcurrency: 1 }, async ([job]) => {
    const { projectId, donorAddress, parsedAmount, transactionHash } =
      job.data;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Check for active matching offers with a row-level lock (FOR UPDATE)
      // to ensure concurrent matching jobs do not over-allocate beyond the cap.
      const matchesResult = await client.query(
        `SELECT id, matcher_address, cap_xlm, matched_xlm, multiplier
         FROM donation_matches
         WHERE project_id = $1 AND expires_at > NOW()
         FOR UPDATE`,
        [projectId],
      );

      for (const match of matchesResult.rows) {
        const matchedXlm = Number.parseFloat(match.matched_xlm || "0");
        const capXlm = Number.parseFloat(match.cap_xlm);
        const remaining = capXlm - matchedXlm;

        if (remaining > 0) {
          const matchAmount = Math.min(
            parsedAmount * match.multiplier,
            remaining,
          );

          await client.query(
            `INSERT INTO donations (
              id, project_id, donor_address, amount_xlm, amount, currency, message, transaction_hash, created_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
            [
              uuid(),
              projectId,
              match.matcher_address,
              matchAmount,
              matchAmount,
              "XLM",
              `Matching donation for donation from ${donorAddress}`,
              `match-${transactionHash}-${match.id}`,
            ],
          );

          await client.query(
            "UPDATE donation_matches SET matched_xlm = matched_xlm + $1 WHERE id = $2",
            [matchAmount, match.id],
          );
        }
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      logger.error(
        { event: "match_queue_job_error", projectId, err: err.message },
        "Match queue job failed",
      );
      throw err; // pg-boss will retry
    } finally {
      client.release();
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
    timeout: 5_000,
  });
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const db = currentBoss.getDb?.();
  if (db?.opened) await db.close();
}

/**
 * Enqueue a donation matching job.
 *
 * @param {{projectId:string, donorAddress:string, parsedAmount:number, transactionHash:string}} params
 * @returns {Promise<string|null>} The pg-boss job id, or null if the queue is not started.
 */
async function enqueueMatchDonation({
  projectId,
  donorAddress,
  parsedAmount,
  transactionHash,
}) {
  if (!boss) {
    // Queue not started — intentionally swallow in tests / dev so callers
    // don't need to guard.
    console.warn(
      "[matchQueue] enqueueMatchDonation called before start(); job dropped",
    );
    return null;
  }
  return boss.send(
    QUEUE,
    { projectId, donorAddress, parsedAmount, transactionHash },
    { retryLimit: 3, retryDelay: 10 },
  );
}

module.exports = { start, stop, enqueueMatchDonation };
