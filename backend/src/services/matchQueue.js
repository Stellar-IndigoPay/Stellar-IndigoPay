"use strict";

/**
 * src/services/matchQueue.js
 *
 * pg-boss-backed donation matching background queue.
 *
 * Previously, donation matching was performed synchronously inside the
 * POST /api/donations handler, which blocked the HTTP response and could
 * fail if the matcher was slow or the DB pool was starved.
 *
 * With this queue:
 *   1. The route handler records the primary donation and enqueues a
 *      matching job, returning immediately to the donor.
 *   2. The background worker applies active matching offers, inserts
 *      matched donation rows, updates the match's matched_xlm counter,
 *      and bumps the project's raised_xlm.
 *   3. Socket.IO events are emitted so the UI stays live.
 */

const { v4: uuid } = require("uuid");
const PgBoss = require("pg-boss");
const pool = require("../db/pool");
const logger = require("../logger");

const QUEUE = "donation-matching";

let boss = null;
let io = null;

// ── Worker logic ──────────────────────────────────────────────────────────

async function processMatching(job) {
  const { projectId, parsedAmount, donorAddress, transactionHash } = job.data;

  const client = await pool.connect();
  let inTransaction = false;

  try {
    // Fetch active matching offers for this project
    const matchesResult = await client.query(
      `SELECT id, matcher_address, cap_xlm, matched_xlm, multiplier
       FROM donation_matches
       WHERE project_id = $1 AND expires_at > NOW()`,
      [projectId],
    );

    if (matchesResult.rows.length === 0) {
      logger.debug(
        { event: "matching_no_offers", projectId },
        "[matchQueue] No active matching offers",
      );
      return;
    }

    // Skip the transaction entirely if every offer is already exhausted
    const hasRemainingCapacity = matchesResult.rows.some((match) => {
      const matchedXlm = Number.parseFloat(match.matched_xlm || "0");
      const capXlm = Number.parseFloat(match.cap_xlm);
      return capXlm - matchedXlm > 0;
    });
    if (!hasRemainingCapacity) {
      logger.debug(
        { event: "matching_all_exhausted", projectId },
        "[matchQueue] All matching offers exhausted",
      );
      return;
    }

    await client.query("BEGIN");
    inTransaction = true;

    let totalMatchedXlm = 0;

    for (const match of matchesResult.rows) {
      const matchedXlm = Number.parseFloat(match.matched_xlm || "0");
      const capXlm = Number.parseFloat(match.cap_xlm);
      const remaining = capXlm - matchedXlm;

      if (remaining <= 0) continue;

      const matchAmount = Math.min(
        parsedAmount * match.multiplier,
        remaining,
      );

      if (matchAmount <= 0) continue;

      // Insert the matched donation row
      await client.query(
        `INSERT INTO donations (
          id, project_id, donor_address, amount_xlm, amount, currency,
          message, transaction_hash, created_at
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

      // Update the match's consumed amount
      await client.query(
        "UPDATE donation_matches SET matched_xlm = matched_xlm + $1 WHERE id = $2",
        [matchAmount, match.id],
      );

      totalMatchedXlm += matchAmount;

      logger.info(
        {
          event: "matching_applied",
          projectId,
          matcherAddress: match.matcher_address,
          matchAmount,
          matchId: match.id,
        },
        "[matchQueue] Matching donation applied",
      );
    }

    // Update project raised_xlm to include matched amounts
    if (totalMatchedXlm > 0) {
      await client.query(
        `UPDATE projects
         SET raised_xlm = raised_xlm + $1::numeric,
             donor_count = (
               SELECT COUNT(DISTINCT donor_address)
               FROM donations
               WHERE project_id = $2
             ),
             updated_at = NOW()
         WHERE id = $2`,
        [totalMatchedXlm, projectId],
      );

      logger.info(
        {
          event: "matching_complete",
          projectId,
          totalMatchedXlm,
          donorAddress,
        },
        "[matchQueue] Matching complete",
      );
    }

    await client.query("COMMIT");
    inTransaction = false;

    // Emit Socket.IO events for matched donations
    if (io && totalMatchedXlm > 0) {
      io.emit("donation_event", {
        projectId,
        donorAddress: "matching",
        amountXLM: totalMatchedXlm,
        transactionHash: `match-${transactionHash}`,
        timestamp: new Date().toISOString(),
        isMatching: true,
      });
    }
  } catch (err) {
    if (inTransaction && client) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // rollback failed, but we still need to rethrow
      }
    }
    logger.error(
      {
        event: "matching_error",
        projectId,
        donorAddress,
        err: err.message,
      },
      "[matchQueue] Matching processing failed",
    );
    throw err; // pg-boss will retry
  } finally {
    if (client) client.release();
  }
}

// ── pg-boss wiring ────────────────────────────────────────────────────────

/**
 * Start the matching queue.
 * Registers a pg-boss worker. Safe to call multiple times.
 *
 * @param {import('socket.io').Server} socketIo - Socket.IO server instance
 */
async function start(socketIo) {
  if (boss) return;
  io = socketIo;

  const connectionString =
    process.env.DATABASE_URL ||
    "postgres://postgres:postgres@localhost:5432/indigopay";

  boss = new PgBoss(connectionString);
  boss.on("error", (err) =>
    logger.error(
      { event: "matchQueue_pgboss_error", err: err.message },
      "[matchQueue] pg-boss error",
    ),
  );

  await boss.start();

  await boss.work(QUEUE, { teamSize: 2, teamConcurrency: 1 }, processMatching);

  logger.info(
    { event: "matchQueue_started", queue: QUEUE },
    "[matchQueue] Worker registered on queue: " + QUEUE,
  );
}

/**
 * Enqueue a donation matching job.
 *
 * @param {string} projectId
 * @param {number} parsedAmount - The original XLM donation amount
 * @param {string} donorAddress  - Stellar public key of the donor
 * @param {string} transactionHash - Original transaction hash
 * @returns {Promise<string>} job ID
 */
async function enqueueDonationMatching(
  projectId,
  parsedAmount,
  donorAddress,
  transactionHash,
) {
  if (!boss) {
    throw new Error("matchQueue not started — call start(io) first");
  }
  return boss.send(
    QUEUE,
    { projectId, parsedAmount, donorAddress, transactionHash },
    { retryLimit: 3, retryDelay: 10 },
  );
}

/**
 * Stop the matching queue gracefully.
 */
async function stop() {
  if (!boss) return;
  try {
    await boss.stop({ graceful: true, timeout: 15_000 });
  } catch (err) {
    logger.warn(
      { event: "matchQueue_stop_error", err: err.message },
      "[matchQueue] Graceful stop failed",
    );
  } finally {
    boss = null;
  }
}

module.exports = { start, stop, enqueueDonationMatching, QUEUE, processMatching };
