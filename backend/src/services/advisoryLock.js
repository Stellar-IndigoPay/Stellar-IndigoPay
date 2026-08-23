"use strict";

/**
 * src/services/advisoryLock.js
 *
 * Distributed mutual exclusion for background cron/keeper workers.
 *
 * Every replica in the k8s HPA (min 2) registers the same optional workers in
 * server.js. Without a distributed guard, two replicas can run the same keeper
 * cycle at once — double-charging recurring donors or double-submitting
 * matching transactions. This module closes that gap with Postgres advisory
 * locks: a session-scoped `pg_try_advisory_lock` that exactly one replica can
 * hold at a time.
 *
 * Advisory locks are session-scoped (not transaction-scoped), so the lock must
 * be taken and released on the SAME database connection. We therefore grab a
 * dedicated client from the pool and hold it for the duration of the guarded
 * work, then release the lock and the client.
 *
 * `pg_try_advisory_lock` is non-blocking: a replica that loses the race gets
 * `false` and skips its cycle rather than queueing behind the winner. Lock keys
 * are derived from the worker name with Postgres' own `hashtext()`, so the
 * mapping is deterministic and shared across replicas.
 */

const pool = require("../db/pool");
const logger = require("../logger");

/**
 * Stable lock names for each cron/keeper cycle. Keep these distinct so a
 * long-running cycle in one worker never blocks a different worker's cycle.
 */
const LOCK_KEYS = Object.freeze({
  recurringKeeper: "worker:recurring_keeper",
  guardian: "worker:guardian",
  matchExpiry: "worker:match_expiry",
  co2Verification: "worker:co2_verification",
});

/**
 * Run `fn` only when this process can acquire the named advisory lock.
 *
 * @param {string} lockName - Stable, unique lock name for the worker cycle.
 * @param {() => Promise<void>} fn - The guarded work. Runs only when the lock
 *   is acquired; its rejection (if any) propagates to the caller after the
 *   lock has been released.
 * @returns {Promise<boolean>} `true` when the lock was acquired and `fn` ran,
 *   `false` when another replica holds the lock (and `fn` was skipped).
 */
async function withAdvisoryLock(lockName, fn) {
  const client = await pool.connect();
  try {
    const lockResult = await client.query(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS acquired",
      [lockName],
    );
    const acquired = Boolean(lockResult.rows[0]?.acquired);

    if (!acquired) {
      logger.debug(
        { event: "advisory_lock_not_acquired", lock: lockName },
        "Another replica holds the advisory lock; skipping this cycle",
      );
      return false;
    }

    try {
      await fn();
      return true;
    } finally {
      try {
        await client.query("SELECT pg_advisory_unlock(hashtext($1))", [
          lockName,
        ]);
      } catch (err) {
        // The connection is about to be released, which drops the lock anyway;
        // log so a stuck lock isn't silent, but never mask `fn`'s outcome.
        logger.warn(
          {
            event: "advisory_lock_unlock_failed",
            lock: lockName,
            err: err.message,
          },
          "Failed to release advisory lock",
        );
      }
    }
  } finally {
    client.release();
  }
}

module.exports = {
  LOCK_KEYS,
  withAdvisoryLock,
};
