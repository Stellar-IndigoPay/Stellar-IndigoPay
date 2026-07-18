"use strict";

const { AsyncLocalStorage } = require("async_hooks");
const { Pool } = require("pg");
const logger = require("../logger");

let dbQueryDurationSeconds;
let dbSlowQueriesTotal;
let dbConnectionErrorsTotal;

function lazyMetrics() {
  if (!dbQueryDurationSeconds) {
    const m = require("../services/metrics");
    dbQueryDurationSeconds = m.metrics.dbQueryDurationSeconds;
    dbSlowQueriesTotal = m.metrics.dbSlowQueriesTotal;
    dbConnectionErrorsTotal = m.metrics.dbConnectionErrorsTotal;
  }
}

const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://postgres:postgres@localhost:5432/indigopay";
const DATABASE_REPLICA_URL = process.env.DATABASE_REPLICA_URL;

const requestDbContext = new AsyncLocalStorage();

function parseEnvInt(name, fallback) {
  return parseInt(process.env[name] || fallback, 10);
}

function createPool(connectionString, maxEnvName, maxDefault) {
  return new Pool({
    connectionString,
    ssl:
      process.env.NODE_ENV === "production"
        ? { rejectUnauthorized: false }
        : false,
    max: parseEnvInt(maxEnvName, maxDefault),
    idleTimeoutMillis: parseEnvInt("DB_POOL_IDLE_TIMEOUT", "30000"),
    // Keep connection acquire + statement timeout within readiness deadlines.
    connectionTimeoutMillis: parseEnvInt("DB_POOL_CONNECT_TIMEOUT", "1000"),
    statement_timeout: parseEnvInt("DB_STATEMENT_TIMEOUT_MS", "3000"),
  });
}

function extractOperation(sql) {
  const match = String(sql).match(/^\s*(\w+)/);
  return match ? match[1].toUpperCase() : "UNKNOWN";
}

function getCallerFrame() {
  const stack = new Error().stack.split("\n");
  for (let i = 2; i < stack.length; i++) {
    if (!stack[i].includes("pool.js")) {
      return stack[i].trim();
    }
  }
  return "";
}

const writerPool = createPool(DATABASE_URL, "DB_POOL_MAX", "20");
const readerPool = DATABASE_REPLICA_URL
  ? createPool(DATABASE_REPLICA_URL, "DB_REPLICA_POOL_MAX", "10")
  : null;

function addPoolLifecycleHandlers(poolInstance, poolName) {
  poolInstance.on("connect", () => {
    logger.info(
      {
        event: `${poolName}_connect`,
        poolName,
        totalCount: poolInstance.totalCount,
        idleCount: poolInstance.idleCount,
        waitingCount: poolInstance.waitingCount,
      },
      `Pool ${poolName}: client connected`,
    );
  });

  poolInstance.on("remove", () => {
    logger.info(
      {
        event: `${poolName}_remove`,
        poolName,
        totalCount: poolInstance.totalCount,
        idleCount: poolInstance.idleCount,
        waitingCount: poolInstance.waitingCount,
      },
      `Pool ${poolName}: client removed`,
    );
  });

  poolInstance.on("acquire", () => {
    logger.info(
      {
        event: `${poolName}_acquire`,
        poolName,
        totalCount: poolInstance.totalCount,
        idleCount: poolInstance.idleCount,
        waitingCount: poolInstance.waitingCount,
      },
      `Pool ${poolName}: client acquired`,
    );
  });
}

writerPool.on("error", (err) => {
  lazyMetrics();
  dbConnectionErrorsTotal.inc();
  logger.error(
    {
      event: "postgres_writer_error",
      err: err.message,
      totalCount: writerPool.totalCount,
      idleCount: writerPool.idleCount,
      waitingCount: writerPool.waitingCount,
    },
    "Unexpected writer pool client error",
  );
});

addPoolLifecycleHandlers(writerPool, "writer");

if (readerPool) {
  readerPool.on("error", (err) => {
    lazyMetrics();
    dbConnectionErrorsTotal.inc();
    logger.warn(
      {
        event: "postgres_reader_error",
        err: err.message,
        totalCount: readerPool.totalCount,
        idleCount: readerPool.idleCount,
        waitingCount: readerPool.waitingCount,
      },
      "Unexpected reader pool client error; reads will fall back to writer",
    );
  });

  addPoolLifecycleHandlers(readerPool, "reader");
}

const writerClient = {
  query: (...args) => writerPool.query(...args),
  connect: (...args) => writerPool.connect(...args),
};

const readerClient = {
  query: async (...args) => {
    if (!readerPool) return writerPool.query(...args);
    try {
      return await readerPool.query(...args);
    } catch (err) {
      logger.warn(
        { event: "reader_query_fallback", err: err.message },
        "Read replica query failed; retrying on writer",
      );
      return writerPool.query(...args);
    }
  },
  connect: async (...args) => {
    if (!readerPool) return writerPool.connect(...args);
    try {
      return await readerPool.connect(...args);
    } catch (err) {
      logger.warn(
        { event: "reader_connect_fallback", err: err.message },
        "Read replica connection failed; using writer",
      );
      return writerPool.connect(...args);
    }
  },
};

function isReadMethod(method) {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

function runWithQueryRole(method, callback) {
  return requestDbContext.run(
    { useReader: isReadMethod(String(method || "").toUpperCase()) },
    callback,
  );
}

function getWriter() {
  return writerClient;
}

function getReader() {
  return readerClient;
}

function getClientForCurrentRequest() {
  const store = requestDbContext.getStore();
  return store?.useReader ? getReader() : getWriter();
}

async function checkReplicaLag() {
  if (!readerPool) return { hasReplica: false, lagMs: 0 };

  try {
    const result = await readerPool.query(
      "SELECT EXTRACT(EPOCH FROM (NOW() - pg_last_xact_replay_timestamp())) * 1000 AS lag_ms",
    );
    return {
      hasReplica: true,
      lagMs: Number(result.rows[0]?.lag_ms) || 0,
    };
  } catch (err) {
    logger.warn(
      { event: "replica_lag_check_failed", err: err.message },
      "Cannot check read replica lag",
    );
    return {
      hasReplica: true,
      lagMs: null,
      error: "Cannot check replica lag",
    };
  }
}

const pool = {
  query: async (...args) => {
    lazyMetrics();
    const start = Date.now();
    const sql = args[0];
    const operation = extractOperation(sql);

    try {
      const result = await getClientForCurrentRequest().query(...args);
      const durationMs = Date.now() - start;
      const durationSec = durationMs / 1000;
      dbQueryDurationSeconds.observe({ operation, success: "true" }, durationSec);

      const threshold = parseInt(
        process.env.SLOW_QUERY_THRESHOLD_MS || "500",
        10,
      );
      if (durationMs > threshold) {
        const queryPreview = String(sql).substring(0, 200);
        const caller = getCallerFrame();
        logger.warn(
          {
            event: "slow_query",
            durationMs,
            operation,
            queryPreview,
            caller,
          },
          `Slow query: ${operation} took ${durationMs}ms`,
        );
        dbSlowQueriesTotal.inc({ operation });
      }

      return result;
    } catch (err) {
      const durationMs = Date.now() - start;
      const durationSec = durationMs / 1000;
      dbQueryDurationSeconds.observe({ operation, success: "false" }, durationSec);
      throw err;
    }
  },
  connect: (...args) => getWriter().connect(...args),
  end: async () => {
    await writerPool.end();
    if (readerPool) await readerPool.end();
  },
  getWriter,
  getReader,
  checkReplicaLag,
  runWithQueryRole,
  _writerPool: writerPool,
  _readerPool: readerPool,
};

module.exports = pool;
