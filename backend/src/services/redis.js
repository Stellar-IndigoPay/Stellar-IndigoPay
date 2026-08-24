"use strict";

/**
 * src/services/redis.js
 *
 * Redis client abstraction for the Stellar IndigoPay backend.
 *
 * Supports two modes:
 *   1. Single-instance (default): REDIS_URL → one ioredis client.
 *   2. Sharded: REDIS_URLS (comma-separated) → multiple clients with
 *      consistent hashing for key routing.
 *   3. Sentinel (failover): REDIS_SENTINELS + REDIS_SENTINEL_MASTER_NAME →
 *      one ioredis client in sentinel mode that auto-reconnects to the
 *      promoted master on failover.
 *
 * Exports:
 *   - getClient([key])  — Returns a Redis client. When `key` is provided,
 *                          routes to the shard responsible for that key.
 *                          When omitted, returns the first (default) client.
 *   - get(key)          — JSON-aware cache read (any shard via routing).
 *   - set(key, val, ttl)— JSON-aware cache write.
 *   - deletePattern(p)  — Deletes all keys matching `pattern` on ALL shards.
 *   - initRedis()       — Force initialise the pool (useful for testing).
 *   - _reset()          — Reset internal state (test-only).
 */

const Redis = require("ioredis");
const { ConsistentHashRing } = require("./consistentHash");
const logger = require("../logger");
const { metrics } = require("./metrics");

/** @type {import("ioredis").Redis[]} */
let clients = [];

/** @type {ConsistentHashRing|null} */
let ring = null;

/** Whether initRedis() has been called at least once. */
let _initialised = false;

/**
 * Parse a comma-separated `host:port` sentinel list into ioredis address
 * objects. Entries without a port default to the standard Sentinel port
 * 26379. Malformed entries are dropped so a single typo can't take down
 * the whole sentinel pool.
 *
 * @param {string} raw - e.g. "sentinel-0:26379,sentinel-1:26379"
 * @returns {Array<{host: string, port: number}>}
 */
function parseSentinels(raw) {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const idx = entry.lastIndexOf(":");
      const host = (idx === -1 ? entry : entry.slice(0, idx)).trim();
      const portStr = idx === -1 ? "" : entry.slice(idx + 1);
      const port = parseInt(portStr, 10);
      return {
        host,
        port: Number.isFinite(port) && port > 0 ? port : 26379,
      };
    })
    .filter((s) => s.host);
}

/**
 * Resolve the sentinel configuration from environment variables, or null
 * when Sentinel mode is not configured (backward-compatible fallback to
 * REDIS_URL / REDIS_URLS).
 *
 * @returns {{ sentinels: Array, name: string }|null}
 */
function sentinelOptions() {
  const raw = process.env.REDIS_SENTINELS;
  const name = process.env.REDIS_SENTINEL_MASTER_NAME;
  if (!raw || !name) return null;

  const sentinels = parseSentinels(raw);
  if (sentinels.length === 0) return null;
  return { sentinels, name };
}

/**
 * Attach lifecycle + failover event handlers to a sentinel-mode client.
 *
 * ioredis sentinel mode auto-reconnects to the promoted master on
 * `+switch-master`, so "reconnect" is provided by the client itself. We
 * subscribe to the observable signals (reconnecting → ready, and the
 * sentinel-level `failoverSubscribed` / `sentinelReconnecting` events the
 * connector forwards to the client) purely to log and emit a metric.
 *
 * @param {import("ioredis").Redis} client
 */
function attachSentinelEventHandlers(client) {
  client.on("reconnecting", (delay) => {
    metrics.redisSentinelFailoverTotal.inc({ outcome: "reconnecting" });
    logger.warn(
      { event: "redis_sentinel_reconnecting", delayMs: delay },
      "Redis Sentinel client reconnecting after master loss",
    );
  });

  client.on("ready", () => {
    metrics.redisSentinelFailoverTotal.inc({ outcome: "ready" });
    logger.info(
      { event: "redis_sentinel_ready" },
      "Redis Sentinel client connected to current master",
    );
  });

  // Forwarded by the SentinelConnector (emitter = client).
  client.on("failoverSubscribed", () => {
    metrics.redisSentinelFailoverTotal.inc({ outcome: "subscribed" });
    logger.info(
      { event: "redis_sentinel_failover_monitoring" },
      "Redis Sentinel failover monitoring armed",
    );
  });

  client.on("sentinelReconnecting", () => {
    logger.warn(
      { event: "redis_sentinel_node_reconnecting" },
      "Redis Sentinel node reconnecting",
    );
  });

  client.on("error", (err) => {
    logger.warn(
      { event: "redis_sentinel_error", err: err.message },
      "Redis Sentinel client error (non-fatal)",
    );
  });
}

/**
 * Initialise Redis connections from environment variables.
 *
 * Priority:
 *   1. Sentinel mode when REDIS_SENTINELS + REDIS_SENTINEL_MASTER_NAME are
 *      both set (single logical master with automatic failover).
 *   2. Sharded mode when REDIS_URLS is set (comma-separated).
 *   3. Single-instance mode via REDIS_URL.
 *
 * @returns {{ clients: import("ioredis").Redis[], ring: ConsistentHashRing }}
 */
function initRedis() {
  if (_initialised) return { clients, ring };

  const sentinel = sentinelOptions();

  if (sentinel) {
    const client = new Redis({
      sentinels: sentinel.sentinels,
      name: sentinel.name,
      // Read from the master; the sentinel layer handles failover.
      role: "master",
      sentinelPassword: process.env.REDIS_SENTINEL_PASSWORD || undefined,
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
    });

    attachSentinelEventHandlers(client);
    client.connect().catch(() => {
      // Non-fatal: server runs without cache until a sentinel/master is up.
    });

    clients = [client];
    ring = new ConsistentHashRing(
      ["shard-0"],
      parseInt(process.env.RATE_LIMIT_CONSISTENT_HASH_VNODES || "150", 10) || 150,
    );
    _initialised = true;
    return { clients, ring };
  }

  const urlsRaw = process.env.REDIS_URLS
    ? process.env.REDIS_URLS.split(",").map((s) => s.trim()).filter(Boolean)
    : [process.env.REDIS_URL || "redis://localhost:6379"];

  clients = urlsRaw.map((url) => {
    const client = new Redis(url, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
    });

    client.on("error", () => {
      // Redis connection errors are non-fatal; bypass cache on failure
    });

    client.connect().catch(() => {
      // Non-fatal: server runs without cache if Redis is unavailable
    });

    return client;
  });

  ring = new ConsistentHashRing(
    clients.map((_, i) => `shard-${i}`),
    parseInt(process.env.RATE_LIMIT_CONSISTENT_HASH_VNODES || "150", 10) || 150,
  );

  _initialised = true;
  return { clients, ring };
}

/**
 * Return a Redis client, optionally routed to a specific shard.
 *
 * @param {string} [key] - Rate-limit key (or other shard-routing key).
 *   When omitted, returns the first (default) client for backward compat.
 * @returns {import("ioredis").Redis}
 */
function getClient(key) {
  if (!_initialised) initRedis();

  if (clients.length === 0) {
    // Should not happen, but guard against empty state
    return new Redis();
  }

  if (key !== undefined && clients.length > 1) {
    const node = ring.getNode(key);
    if (node !== null) {
      // Parse "shard-N" → index N
      const idx = parseInt(node.split("-")[1], 10);
      if (!isNaN(idx) && idx >= 0 && idx < clients.length) {
        return clients[idx];
      }
    }
  }

  // Default: return the first client (backward compatible)
  return clients[0];
}

/**
 * Read a JSON value from the cache.
 *
 * For sharded environments the key is routed through consistent hashing.
 *
 * @param {string} key
 * @returns {Promise<*>} Parsed JSON value or null on miss/error.
 */
async function get(key) {
  try {
    const c = getClient(key);
    const value = await c.get(key);
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

/**
 * Write a JSON value to the cache.
 *
 * For sharded environments the key is routed through consistent hashing.
 *
 * @param {string} key
 * @param {*}      value      - Any JSON-serialisable value
 * @param {number} [ttlSeconds]- Optional TTL in seconds
 * @returns {Promise<void>}
 */
async function set(key, value, ttlSeconds) {
  try {
    const c = getClient(key);
    if (ttlSeconds !== undefined && ttlSeconds > 0) {
      await c.set(key, JSON.stringify(value), "EX", ttlSeconds);
    } else {
      await c.set(key, JSON.stringify(value));
    }
  } catch {
    // Cache write failure is non-fatal
  }
}

/**
 * Delete all keys matching `pattern` across ALL shards.
 *
 * This is intentionally NOT shard-routed because patterns like
 * "cache:projects:*" need to sweep every Redis instance.
 *
 * @param {string} pattern - Redis glob pattern (e.g. "cache:projects:*")
 * @returns {Promise<void>}
 */
async function deletePattern(pattern) {
  if (!_initialised) initRedis();

  const results = await Promise.allSettled(
    clients.map(async (c) => {
      const keys = await c.keys(pattern);
      if (keys.length > 0) {
        await c.del(...keys);
      }
    }),
  );

  // Log failures but don't throw — cache invalidation is best-effort
  const failures = results.filter((r) => r.status === "rejected");
  if (failures.length > 0) {
    // Swallow; cache invalidation failures are non-fatal. Operators can
    // detect partial invalidation by monitoring per-shard key counts.
  }
}

/**
 * Return the number of connected shards (for health checks).
 * @returns {number}
 */
function shardCount() {
  return clients.length;
}

/**
 * Test-only: reset internal state so tests can re-initialise with
 * different environment variables.
 *
 * @package
 */
function _reset() {
  clients = [];
  ring = null;
  _initialised = false;
}

module.exports = { getClient, get, set, deletePattern, initRedis, shardCount, parseSentinels, sentinelOptions, _reset };
