"use strict";

// ── Helper function tests (no mocking needed) ─────────────────────────────

describe("parameterizeQuery", () => {
  let parameterizeQuery;

  beforeAll(() => {
    jest.resetModules();
    jest.doMock("../logger", () => ({
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
    }));
    jest.doMock("../services/metrics", () => ({
      metrics: {
        dbQueryDurationSeconds: { observe: jest.fn() },
        dbSlowQueriesTotal: { inc: jest.fn() },
        dbConnectionErrorsTotal: { inc: jest.fn() },
      },
    }));
    parameterizeQuery = require("./pool").parameterizeQuery;
  });

  afterAll(() => {
    jest.dontMock("../logger");
    jest.dontMock("../services/metrics");
  });

  test("replaces single-quoted string literals with $N placeholder", () => {
    const result = parameterizeQuery(
      "SELECT * FROM users WHERE name = 'Alice' AND city = 'Paris'",
    );
    expect(result).toBe("SELECT * FROM users WHERE name = '$N' AND city = '$N'");
  });

  test("replaces numeric literals with $N placeholder", () => {
    const result = parameterizeQuery("SELECT * FROM items WHERE price > 42 AND qty = 100");
    expect(result).toMatch(/price > \$N/);
    expect(result).toMatch(/qty = \$N/);
  });

  test("handles floating-point numeric literals", () => {
    const result = parameterizeQuery("UPDATE prices SET rate = 1.25 WHERE id = 5");
    expect(result).toMatch(/rate = \$N/);
    expect(result).toMatch(/id = \$N/);
  });

  test("leaves non-literal text unchanged", () => {
    const result = parameterizeQuery("SELECT column FROM table");
    expect(result).toBe("SELECT column FROM table");
  });

  test("handles SQL with mixed literals and identifiers", () => {
    const result = parameterizeQuery(
      "INSERT INTO orders (user_id, amount) VALUES (7, 19.99)",
    );
    // Identifiers (user_id, amount) are preserved; only value literals are replaced.
    expect(result).toBe(
      "INSERT INTO orders (user_id, amount) VALUES ($N, $N)",
    );
  });
});

describe("extractQueryType", () => {
  let extractQueryType;

  beforeAll(() => {
    jest.resetModules();
    jest.doMock("../logger", () => ({
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
    }));
    jest.doMock("../services/metrics", () => ({
      metrics: {
        dbQueryDurationSeconds: { observe: jest.fn() },
        dbSlowQueriesTotal: { inc: jest.fn() },
        dbConnectionErrorsTotal: { inc: jest.fn() },
      },
    }));
    extractQueryType = require("./pool").extractQueryType;
  });

  afterAll(() => {
    jest.dontMock("../logger");
    jest.dontMock("../services/metrics");
  });

  test("extracts SELECT from leading keyword", () => {
    expect(extractQueryType("SELECT * FROM users")).toBe("SELECT");
  });

  test("extracts INSERT from leading keyword", () => {
    expect(extractQueryType("INSERT INTO users (name) VALUES ('x')")).toBe("INSERT");
  });

  test("extracts UPDATE from leading keyword", () => {
    expect(extractQueryType("UPDATE users SET name = 'x'")).toBe("UPDATE");
  });

  test("extracts DELETE from leading keyword", () => {
    expect(extractQueryType("DELETE FROM users WHERE id = 1")).toBe("DELETE");
  });

  test("extracts WITH from CTE prefix", () => {
    expect(extractQueryType("WITH cte AS (SELECT 1) SELECT * FROM cte")).toBe("WITH");
  });

  test("returns OTHER for unrecognised keywords", () => {
    expect(extractQueryType("SET statement_timeout = '3s'")).toBe("OTHER");
  });

  test("is case-insensitive", () => {
    expect(extractQueryType("  select count(*) from users")).toBe("SELECT");
  });

  test("handles leading whitespace", () => {
    expect(extractQueryType("\n\t  DELETE FROM logs")).toBe("DELETE");
  });
});

describe("extractOperation", () => {
  let extractOperation;

  beforeAll(() => {
    jest.resetModules();
    jest.doMock("../logger", () => ({
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
    }));
    jest.doMock("../services/metrics", () => ({
      metrics: {
        dbQueryDurationSeconds: { observe: jest.fn() },
        dbSlowQueriesTotal: { inc: jest.fn() },
        dbConnectionErrorsTotal: { inc: jest.fn() },
      },
    }));
    extractOperation = require("./pool").extractOperation;
  });

  afterAll(() => {
    jest.dontMock("../logger");
    jest.dontMock("../services/metrics");
  });

  test("extracts first word regardless of SQL keyword type", () => {
    expect(extractOperation("CREATE INDEX idx ON users(name)")).toBe("CREATE");
  });

  test("uppercases the extracted keyword", () => {
    expect(extractOperation("explain analyze select 1")).toBe("EXPLAIN");
  });

  test("returns UNKNOWN for empty or whitespace strings", () => {
    expect(extractOperation("   ")).toBe("UNKNOWN");
  });
});

// ── Pool integration tests ──────────────────────────────────────────────────

describe("db/pool read replica routing", () => {
  let MockPool;
  let instances;
  let mockMetrics;
  const originalEnv = { ...process.env };

  function loadPool({ replicaUrl } = {}) {
    jest.resetModules();
    instances = [];
    mockMetrics = {
      dbQueryDurationSeconds: { observe: jest.fn() },
      dbSlowQueriesTotal: { inc: jest.fn() },
      dbConnectionErrorsTotal: { inc: jest.fn() },
    };

    MockPool = jest.fn().mockImplementation((config) => {
      const instance = {
        config,
        query: jest.fn().mockResolvedValue({ rows: [] }),
        connect: jest.fn(),
        end: jest.fn().mockResolvedValue(undefined),
        on: jest.fn(),
        totalCount: 5,
        idleCount: 3,
        waitingCount: 0,
      };
      instances.push(instance);
      return instance;
    });

    process.env.NODE_ENV = "test";
    process.env.DATABASE_URL = "postgres://writer/db";
    if (replicaUrl) {
      process.env.DATABASE_REPLICA_URL = replicaUrl;
    } else {
      delete process.env.DATABASE_REPLICA_URL;
    }

    jest.doMock("pg", () => ({ Pool: MockPool }));
    jest.doMock("../logger", () => ({
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
    }));
    jest.doMock("../services/metrics", () => ({
      metrics: mockMetrics,
    }));

    return require("./pool");
  }

  afterEach(() => {
    jest.dontMock("pg");
    jest.dontMock("../logger");
    jest.dontMock("../services/metrics");
    process.env = { ...originalEnv };
  });

  test("getReader falls back to writer when no replica is configured", async () => {
    const pool = loadPool();

    await pool.getReader().query("SELECT 1");

    expect(instances).toHaveLength(1);
    expect(instances[0].query).toHaveBeenCalledWith("SELECT 1");
  });

  test("getReader uses the replica pool when DATABASE_REPLICA_URL is configured", async () => {
    const pool = loadPool({ replicaUrl: "postgres://reader/db" });

    await pool.getReader().query("SELECT 1");

    expect(instances).toHaveLength(2);
    expect(instances[0].query).not.toHaveBeenCalled();
    expect(instances[1].query).toHaveBeenCalledWith("SELECT 1");
  });

  test("reader query falls back to writer when the replica query fails", async () => {
    const pool = loadPool({ replicaUrl: "postgres://reader/db" });
    instances[1].query.mockRejectedValueOnce(new Error("replica down"));

    await pool.getReader().query("SELECT 1");

    expect(instances[1].query).toHaveBeenCalledWith("SELECT 1");
    expect(instances[0].query).toHaveBeenCalledWith("SELECT 1");
  });

  test("checkReplicaLag returns replica lag in milliseconds", async () => {
    const pool = loadPool({ replicaUrl: "postgres://reader/db" });
    instances[1].query.mockResolvedValueOnce({ rows: [{ lag_ms: "123.4" }] });

    await expect(pool.checkReplicaLag()).resolves.toEqual({
      hasReplica: true,
      lagMs: 123.4,
    });
  });

  test("pool.query routes GET context to reader and POST context to writer", async () => {
    const pool = loadPool({ replicaUrl: "postgres://reader/db" });

    await pool.runWithQueryRole("GET", () => pool.query("SELECT read"));
    await pool.runWithQueryRole("POST", () => pool.query("SELECT write"));

    expect(instances[1].query).toHaveBeenCalledWith("SELECT read");
    expect(instances[0].query).toHaveBeenCalledWith("SELECT write");
  });

  describe("instrumentation", () => {
    test("records query duration histogram on success", async () => {
      const pool = loadPool();
      await pool.query("SELECT 1");
      expect(mockMetrics.dbQueryDurationSeconds.observe).toHaveBeenCalledWith(
        { operation: "SELECT", success: "true" },
        expect.any(Number),
      );
    });

    test("records query duration histogram on failure", async () => {
      const pool = loadPool();
      instances[0].query.mockRejectedValueOnce(new Error("db error"));
      await expect(pool.query("SELECT 1")).rejects.toThrow("db error");
      expect(mockMetrics.dbQueryDurationSeconds.observe).toHaveBeenCalledWith(
        { operation: "SELECT", success: "false" },
        expect.any(Number),
      );
    });

    test("does not log slow query when duration is under threshold", async () => {
      jest.useFakeTimers();
      const pool = loadPool();
      const warn = require("../logger").warn;
      instances[0].query.mockImplementation(async () => {
        jest.advanceTimersByTime(100);
        return { rows: [] };
      });
      await pool.query("SELECT 1");
      expect(warn).not.toHaveBeenCalled();
      jest.useRealTimers();
    });

    test("logs slow query when duration exceeds threshold", async () => {
      jest.useFakeTimers();
      const pool = loadPool();
      const warn = require("../logger").warn;
      instances[0].query.mockImplementation(async () => {
        jest.advanceTimersByTime(600);
        return { rows: [] };
      });
      await pool.query("SELECT 1");
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "slow_query",
          operation: "SELECT",
        }),
        expect.any(String),
      );
      jest.useRealTimers();
    });

    test("extracts operation from first SQL keyword", async () => {
      const pool = loadPool();
      await pool.query("INSERT INTO foo (bar) VALUES (1)");
      expect(mockMetrics.dbQueryDurationSeconds.observe).toHaveBeenCalledWith(
        expect.objectContaining({ operation: "INSERT" }),
        expect.any(Number),
      );
    });

    test("increments slow queries counter on slow query", async () => {
      jest.useFakeTimers();
      const pool = loadPool();
      instances[0].query.mockImplementation(async () => {
        jest.advanceTimersByTime(600);
        return { rows: [] };
      });
      await pool.query("SELECT 1");
      expect(mockMetrics.dbSlowQueriesTotal.inc).toHaveBeenCalledWith({
        operation: "SELECT",
      });
      jest.useRealTimers();
    });
  });
});
