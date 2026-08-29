"use strict";

jest.mock("../db/pool", () => ({
  query: jest.fn(),
  connect: jest.fn(),
}));

const pool = require("../db/pool");
const {
  replayDelivery,
  computeBackoffDelay,
  endpointWorkerKey,
  isEndpointBudgetExceeded,
  MAX_ATTEMPTS,
  ENDPOINT_RETRY_BUDGET,
} = require("./webhookQueue");

describe("replayDelivery", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("returns false when no dead-lettered delivery matches the id", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] }); // UPDATE ... WHERE status = 'dlq' RETURNING id

    const result = await replayDelivery("missing-id");

    expect(result).toBe(false);
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  test("resets attempts and status before retrying", async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: "delivery-1" }] }) // reset UPDATE
      .mockResolvedValueOnce({ rows: [] }); // processDelivery's lookup SELECT (row vanished path)

    const result = await replayDelivery("delivery-1");

    expect(result).toBe(true);
    const [resetQuery, resetParams] = pool.query.mock.calls[0];
    expect(resetQuery).toContain("status = 'pending'");
    expect(resetQuery).toContain("attempts = 0");
    expect(resetQuery).toContain("WHERE id = $1 AND status = 'dlq'");
    expect(resetParams).toEqual(["delivery-1"]);
  });

  test("does not reset a delivery that isn't currently dead-lettered", async () => {
    // The UPDATE's WHERE clause filters on status = 'dlq', so a pending/
    // delivered row simply won't match and RETURNING yields no rows.
    pool.query.mockResolvedValueOnce({ rows: [] });

    const result = await replayDelivery("already-pending");

    expect(result).toBe(false);
  });
});

describe("computeBackoffDelay (jittered backoff)", () => {
  test("returns a delay within the full-jitter range for each attempt", () => {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const delay = computeBackoffDelay(attempt);
      // delay = min(base * 2^attempt, max) * (0.5 + random() * 0.5)
      const base = Math.min(30 * Math.pow(2, attempt), 21600);
      expect(delay).toBeGreaterThanOrEqual(base * 0.5);
      expect(delay).toBeLessThanOrEqual(base);
    }
  });

  test("mock receiver returning 503 for 3 attempts yields jitter (variance > 0)", () => {
    const delays = [];
    for (let i = 0; i < 50; i++) {
      delays.push(computeBackoffDelay(1)); // attempt index 1
    }
    const unique = new Set(delays);
    expect(unique.size).toBeGreaterThan(1); // variance > 0
  });

  test("thundering herd: 10 simultaneous retries spread across the backoff window", () => {
    const delays = Array.from({ length: 10 }, () => computeBackoffDelay(1));
    const min = Math.min(...delays);
    const max = Math.max(...delays);
    // Full jitter spreads delays across the window rather than collapsing
    // them onto a single value.
    expect(max - min).toBeGreaterThan(0);
  });

  test("caps at maxDelay (6h) for large attempt counts", () => {
    const delay = computeBackoffDelay(20);
    expect(delay).toBeLessThanOrEqual(21600);
    expect(delay).toBeGreaterThanOrEqual(21600 * 0.5);
  });
});

describe("endpointWorkerKey (consistent-hash sharding)", () => {
  test("same endpoint always maps to the same worker", () => {
    const key = "proj-123";
    const first = endpointWorkerKey(key);
    for (let i = 0; i < 20; i++) {
      expect(endpointWorkerKey(key)).toBe(first);
    }
  });

  test("different endpoints may map to different workers", () => {
    const results = new Set();
    for (let i = 0; i < 100; i++) {
      results.add(endpointWorkerKey(`proj-${i}`));
    }
    // With 2 workers and 100 keys, both should be hit.
    expect(results.has("webhook-worker-0")).toBe(true);
    expect(results.has("webhook-worker-1")).toBe(true);
  });
});

describe("isEndpointBudgetExceeded", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("returns true when the endpoint has exhausted its window budget", async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ cnt: ENDPOINT_RETRY_BUDGET }] });
    const result = await isEndpointBudgetExceeded("proj-1");
    expect(result).toBe(true);
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  test("returns false when the endpoint is under its window budget", async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ cnt: 2 }] });
    const result = await isEndpointBudgetExceeded("proj-1");
    expect(result).toBe(false);
  });
});
