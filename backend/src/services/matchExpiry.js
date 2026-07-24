/**
 * src/services/matchExpiry.js
 *
 * Background service that automatically deactivates donation match pools
 * when they have either:
 *   - expired (expires_at < NOW()), or
 *   - been exhausted (matched_xlm >= cap_xlm)
 *
 * Runs every 15 minutes via setInterval. Starts with startServer() in server.js.
 */
"use strict";

const pool = require("../db/pool");
const logger = require("../logger");

const INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Deactivate all match pools that have either expired or been exhausted.
 * Expired pools (time-based) are set to status = 'expired'.
 * Exhausted pools (cap reached) are set to status = 'exhausted'.
 * Only transitions pools currently in status = 'active'.
 *
 * @returns {Promise<{expired: number, exhausted: number}>} Counts of affected rows.
 */
async function checkAndExpireMatches() {
  try {
    // Mark time-expired pools
    const expiredResult = await pool.query(`
      UPDATE donation_matches
      SET status = 'expired'
      WHERE expires_at < NOW()
        AND status = 'active'
    `);

    // Mark cap-exhausted pools
    const exhaustedResult = await pool.query(`
      UPDATE donation_matches
      SET status = 'exhausted'
      WHERE matched_xlm >= cap_xlm
        AND status = 'active'
    `);

    const expired = expiredResult.rowCount || 0;
    const exhausted = exhaustedResult.rowCount || 0;

    if (expired > 0 || exhausted > 0) {
      logger.info(
        { event: "match_expiry_run", expired, exhausted },
        `Match expiry: ${expired} expired, ${exhausted} exhausted`,
      );
    }

    return { expired, exhausted };
  } catch (err) {
    logger.error(
      { event: "match_expiry_error", err: err.message },
      "Match expiry check failed",
    );
    return { expired: 0, exhausted: 0 };
  }
}

let _intervalHandle = null;

/**
 * Start the match expiry background cron.
 * Runs immediately on start, then every INTERVAL_MS (15 minutes).
 */
function start() {
  if (_intervalHandle) return; // already running
  // Run once immediately on startup
  checkAndExpireMatches().catch(() => {});
  _intervalHandle = setInterval(checkAndExpireMatches, INTERVAL_MS);
  logger.info({ event: "match_expiry_started" }, "Match expiry service started");
}

/**
 * Stop the match expiry background cron.
 */
function stop() {
  if (_intervalHandle) {
    clearInterval(_intervalHandle);
    _intervalHandle = null;
    logger.info({ event: "match_expiry_stopped" }, "Match expiry service stopped");
  }
}

module.exports = { checkAndExpireMatches, start, stop };
