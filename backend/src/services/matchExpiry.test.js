/**
 * src/services/matchExpiry.test.js
 */
"use strict";

jest.mock("../db/pool", () => ({
  query: jest.fn(),
}));

jest.mock("../logger", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

// Re-require after mocks so the module picks them up
let matchExpiry;
let pool;
beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  // Clear module cache so each test gets a fresh interval handle
  jest.resetModules();
  pool = require("../db/pool");
  matchExpiry = require("./matchExpiry");
});

afterEach(() => {
  matchExpiry.stop();
  jest.useRealTimers();
});

describe("checkAndExpireMatches", () => {
  test("runs two UPDATE queries and returns counts", async () => {
    pool.query
      .mockResolvedValueOnce({ rowCount: 2 }) // expired
      .mockResolvedValueOnce({ rowCount: 1 }); // exhausted

    const result = await matchExpiry.checkAndExpireMatches();

    expect(result).toEqual({ expired: 2, exhausted: 1 });
    expect(pool.query).toHaveBeenCalledTimes(2);

    const [expiredSql] = pool.query.mock.calls[0];
    expect(expiredSql).toMatch(/status = 'expired'/);
    expect(expiredSql).toMatch(/expires_at < NOW\(\)/);
    expect(expiredSql).toMatch(/status = 'active'/);

    const [exhaustedSql] = pool.query.mock.calls[1];
    expect(exhaustedSql).toMatch(/status = 'exhausted'/);
    expect(exhaustedSql).toMatch(/matched_xlm >= cap_xlm/);
    expect(exhaustedSql).toMatch(/status = 'active'/);
  });

  test("returns zeros when no rows updated", async () => {
    pool.query
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({ rowCount: 0 });

    const result = await matchExpiry.checkAndExpireMatches();
    expect(result).toEqual({ expired: 0, exhausted: 0 });
  });

  test("returns zeros and logs error on DB failure", async () => {
    const logger = require("../logger");
    pool.query.mockRejectedValueOnce(new Error("DB down"));

    const result = await matchExpiry.checkAndExpireMatches();
    expect(result).toEqual({ expired: 0, exhausted: 0 });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: "match_expiry_error" }),
      expect.any(String),
    );
  });
});

describe("start / stop", () => {
  test("start schedules an interval and calls checkAndExpireMatches immediately", async () => {
    pool.query
      .mockResolvedValue({ rowCount: 0 });

    matchExpiry.start();
    // advance past the immediate call
    await Promise.resolve();
    expect(pool.query).toHaveBeenCalled();
  });

  test("stop clears the interval (calling start twice does not double-register)", async () => {
    pool.query.mockResolvedValue({ rowCount: 0 });

    matchExpiry.start();
    matchExpiry.start(); // second call should be a no-op

    // Wait for immediate async run (both queries) to complete
    await Promise.resolve();
    await Promise.resolve();

    const callsAfterStart = pool.query.mock.calls.length;
    matchExpiry.stop();

    jest.advanceTimersByTime(15 * 60 * 1000 + 1000);
    await Promise.resolve();
    await Promise.resolve();

    // No new calls after stop
    expect(pool.query.mock.calls.length).toBe(callsAfterStart);
  });
});
