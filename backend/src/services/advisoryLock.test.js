"use strict";

/**
 * src/services/advisoryLock.test.js
 *
 * Proves the per-worker advisory lock only lets one concurrent cycle run.
 * The fake pool client reproduces Postgres' `pg_try_advisory_lock` semantics
 * (exactly one session holds a given key at a time) so the concurrency test
 * is deterministic and needs no database.
 */

jest.mock("../db/pool", () => ({
  connect: jest.fn(),
}));

jest.mock("../logger", () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

const pool = require("../db/pool");
const logger = require("../logger");
const { withAdvisoryLock, LOCK_KEYS } = require("./advisoryLock");

function makeFakeClient(heldLocks) {
  return {
    query: jest.fn(async (sql, params) => {
      const name = params && params[0];
      if (String(sql).includes("pg_try_advisory_lock")) {
        if (heldLocks.has(name)) {
          return { rows: [{ acquired: false }] };
        }
        heldLocks.add(name);
        return { rows: [{ acquired: true }] };
      }
      if (String(sql).includes("pg_advisory_unlock")) {
        heldLocks.delete(name);
        return { rows: [] };
      }
      return { rows: [] };
    }),
    release: jest.fn(),
  };
}

function waitFor(predicate, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) {
        return reject(new Error("waitFor timed out"));
      }
      setTimeout(check, 0);
    };
    check();
  });
}

describe("withAdvisoryLock", () => {
  let heldLocks;
  let clients;

  beforeEach(() => {
    jest.clearAllMocks();
    heldLocks = new Set();
    clients = [];
    pool.connect.mockImplementation(async () => {
      const client = makeFakeClient(heldLocks);
      clients.push(client);
      return client;
    });
  });

  test("runs fn, releases the lock, and releases the client when acquired", async () => {
    const fn = jest.fn().mockResolvedValue(undefined);

    const result = await withAdvisoryLock("worker:test", fn);

    expect(result).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);

    const client = clients[0];
    expect(client.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("pg_try_advisory_lock"),
      ["worker:test"],
    );
    expect(client.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("pg_advisory_unlock"),
      ["worker:test"],
    );
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(heldLocks.size).toBe(0);
  });

  test("skips fn and returns false when another session holds the lock", async () => {
    heldLocks.add("worker:test");
    const fn = jest.fn().mockResolvedValue(undefined);

    const result = await withAdvisoryLock("worker:test", fn);

    expect(result).toBe(false);
    expect(fn).not.toHaveBeenCalled();
    expect(clients[0].release).toHaveBeenCalledTimes(1);
    // The pre-existing lock (simulating the other replica) is untouched.
    expect(heldLocks.has("worker:test")).toBe(true);
  });

  test("releases the lock and rethrows when fn throws", async () => {
    const fn = jest.fn().mockRejectedValue(new Error("boom"));

    await expect(withAdvisoryLock("worker:test", fn)).rejects.toThrow("boom");

    expect(heldLocks.size).toBe(0);
    expect(clients[0].release).toHaveBeenCalledTimes(1);
  });

  test("still releases the client when the lock query itself fails", async () => {
    pool.connect.mockImplementationOnce(async () => {
      const client = makeFakeClient(heldLocks);
      client.query.mockRejectedValueOnce(new Error("db down"));
      clients.push(client);
      return client;
    });

    await expect(withAdvisoryLock("worker:test", jest.fn())).rejects.toThrow(
      "db down",
    );
    expect(clients[0].release).toHaveBeenCalledTimes(1);
  });

  test("logs a warning and still completes when unlock fails", async () => {
    const fn = jest.fn().mockResolvedValue(undefined);
    const client = makeFakeClient(heldLocks);
    const originalQuery = client.query;
    client.query = jest.fn(async (sql, params) => {
      if (String(sql).includes("pg_advisory_unlock")) {
        throw new Error("unlock failed");
      }
      return originalQuery(sql, params);
    });
    pool.connect.mockImplementationOnce(async () => {
      clients.push(client);
      return client;
    });

    await expect(
      withAdvisoryLock("worker:test", fn),
    ).resolves.toBe(true);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "advisory_lock_unlock_failed" }),
      expect.any(String),
    );
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  test("two concurrent cycles for the same worker: only one executes", async () => {
    let firstRan = false;
    let secondRan = false;
    let releaseFirst;
    const firstHolding = new Promise((resolve) => (releaseFirst = resolve));

    const first = withAdvisoryLock("worker:recurring_keeper", async () => {
      firstRan = true;
      await firstHolding;
    });

    // Wait until the first cycle has actually acquired the lock.
    await waitFor(() => firstRan);

    const second = await withAdvisoryLock(
      "worker:recurring_keeper",
      async () => {
        secondRan = true;
      },
    );

    expect(second).toBe(false);
    expect(secondRan).toBe(false);

    releaseFirst();
    const firstResult = await first;
    expect(firstResult).toBe(true);
    expect(firstRan).toBe(true);
  });
});

describe("LOCK_KEYS", () => {
  test("every worker has a distinct lock name", () => {
    const values = Object.values(LOCK_KEYS);
    expect(new Set(values).size).toBe(values.length);
  });
});
