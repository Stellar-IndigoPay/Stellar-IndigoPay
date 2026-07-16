"use strict";

/**
 * src/routes/admin/audit-stats.js
 *
 * Aggregated statistics for the admin audit log.
 *
 * Mounted under `/api/admin/audit-log` (see routes/admin.js):
 *   - GET /api/admin/audit-log/stats
 *
 * Returns:
 *   {
 *     topActions:   [{ action, count }],
 *     topActors:    [{ actor, count }],
 *     dailyVolume:  [{ date, count }],
 *     totalEntries, oldestEntry, newestEntry
 *   }
 *
 * Results are cached in Redis (services/redis) for 15 minutes when Redis is
 * available; otherwise the request falls through to a live query every time.
 * Cache failures are non-fatal (graceful skip).
 */

const express = require("express");
const router = express.Router();
const pool = require("../../db/pool");
const { adminRequired } = require("../../middleware/auth");
const { get: redisGet, set: redisSet } = require("../../services/redis");

const STATS_CACHE_TTL_SECONDS = 15 * 60; // 15 minutes
const STATS_CACHE_KEY = "audit-log:stats";

async function computeStats() {
  const [topActionsRes, topActorsRes, dailyRes, totalsRes] =
    await Promise.all([
      pool.query(
        `SELECT action, COUNT(*)::bigint AS count
         FROM admin_audit_log
         GROUP BY action
         ORDER BY count DESC
         LIMIT 10`,
      ),
      pool.query(
        `SELECT actor, COUNT(*)::bigint AS count
         FROM admin_audit_log
         GROUP BY actor
         ORDER BY count DESC
         LIMIT 10`,
      ),
      pool.query(
        `SELECT TO_CHAR(created_at, 'YYYY-MM-DD') AS date, COUNT(*)::bigint AS count
         FROM admin_audit_log
         GROUP BY date
         ORDER BY date ASC`,
      ),
      pool.query(
        `SELECT
           COUNT(*)::bigint AS total_entries,
           MIN(created_at) AS oldest_entry,
           MAX(created_at) AS newest_entry
         FROM admin_audit_log`,
      ),
    ]);

  const totals = totalsRes.rows[0] || {
    total_entries: 0,
    oldest_entry: null,
    newest_entry: null,
  };

  return {
    topActions: topActionsRes.rows.map((r) => ({
      action: r.action,
      count: Number(r.count),
    })),
    topActors: topActorsRes.rows.map((r) => ({
      actor: r.actor,
      count: Number(r.count),
    })),
    dailyVolume: dailyRes.rows.map((r) => ({
      date: r.date,
      count: Number(r.count),
    })),
    totalEntries: Number(totals.total_entries),
    oldestEntry: totals.oldest_entry,
    newestEntry: totals.newest_entry,
  };
}

router.get("/stats", adminRequired, async (req, res, next) => {
  try {
    // Try the cache first (graceful: redisGet returns null on any error).
    let stats = await redisGet(STATS_CACHE_KEY);
    if (!stats) {
      stats = await computeStats();
      await redisSet(STATS_CACHE_KEY, stats, STATS_CACHE_TTL_SECONDS);
    }
    return res.status(200).json({ success: true, data: stats });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
module.exports.computeStats = computeStats;
