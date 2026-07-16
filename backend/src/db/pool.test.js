"use strict";

describe("db/pool read replica routing", () => {
  let MockPool;
  let instances;
  const originalEnv = { ...process.env };

  function loadPool({ replicaUrl } = {}) {
    jest.resetModules();
    instances = [];
    MockPool = jest.fn().mockImplementation((config) => {
      const instance = {
        config,
        query: jest.fn().mockResolvedValue({ rows: [] }),
        connect: jest.fn(),
        end: jest.fn().mockResolvedValue(undefined),
        on: jest.fn(),
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
    }));

    return require("./pool");
  }

  afterEach(() => {
    jest.dontMock("pg");
    jest.dontMock("../logger");
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
});
