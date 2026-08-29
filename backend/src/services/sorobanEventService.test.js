"use strict";

process.env.SOROBAN_DLQ_BACKOFF_BASE_MS = "30000";
process.env.SOROBAN_DLQ_BACKOFF_MAX_MS = String(8 * 60 * 60 * 1000);
process.env.SOROBAN_DLQ_JITTER_MAX_MS = "5000";
process.env.SOROBAN_DLQ_POLL_INTERVAL_MS = "60000";
process.env.SOROBAN_DLQ_BATCH_SIZE = "10";

jest.mock("../logger", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock("./metrics", () => ({
  registry: { registerMetric: jest.fn() },
}));
jest.mock("../db/pool", () => ({
  query: jest.fn(),
  connect: jest.fn(),
}));
jest.mock("./stellar", () => ({
  rpcServer: "https://fake.testnet.stellar.org",
  CONTRACT_ID: "GINDIGOPAYTEST",
  withRetry: (fn) => fn(),
}));
jest.mock("./store", () => ({ computeBadges: jest.fn(() => []) }));
jest.mock("./projectionEngine", () => ({ insertEvent: jest.fn(), processEvent: jest.fn() }));
jest.mock("@stellar/stellar-sdk", () => ({
  xdr: { ScVal: { fromXDR: jest.fn() } },
  scValToNative: jest.fn(),
}));

const pool = require("../db/pool");
const logger = require("../logger");
const {
  calculateBackoff,
  writeToDLQ,
  retryDLQEntry,
  pollDLQ,
} = require("./sorobanEventService");

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("sorobanEventService — DLQ retry policy", () => {
  test("calculateBackoff escalates exponentially with jitter", () => {
    jest.spyOn(Math, "random").mockReturnValue(0.5);
    expect(calculateBackoff(0)).toBe(30_000 + 2_500);
    expect(calculateBackoff(1)).toBe(60_000 + 2_500);
    expect(calculateBackoff(2)).toBe(120_000 + 2_500);
  });

  test("calculateBackoff caps at the 8h maximum", () => {
    jest.spyOn(Math, "random").mockReturnValue(0);
    expect(calculateBackoff(10)).toBe(8 * 60 * 60 * 1000);
  });

  test("writeToDLQ inserts a pending entry with retry state and upsert dedup", async () => {
    const evt = { pagingToken: "tok-1", ledger: 42, txHash: "tx-1" };
    const error = new Error("processing failed");

    await writeToDLQ(evt, "donated", error);

    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain("INSERT INTO soroban_event_dlq");
    expect(sql).toContain("ON CONFLICT (paging_token)");
    expect(sql).toContain("status IN ('pending', 'retrying')");
    expect(params).toEqual([
      "donated",
      "GINDIGOPAYTEST",
      "tok-1",
      JSON.stringify(evt),
      "processing failed",
      error.stack,
      3,
      3,
    ]);
  });

  test("retryDLQEntry marks a successful retry as resolved", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const result = await retryDLQEntry({
      id: 1,
      event_type: "co2_rate",
      event_data: JSON.stringify({ pagingToken: "tok-1" }),
      retry_count: 0,
      max_retries: 3,
    });

    expect(result).toEqual({ outcome: "resolved" });
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain("status = 'resolved'");
    expect(params).toEqual([1]);
  });

  test("retryDLQEntry schedules a backoff retry when the handler still fails", async () => {
    logger.info.mockImplementationOnce(() => {
      throw new Error("handler boom");
    });

    const result = await retryDLQEntry({
      id: 7,
      event_type: "co2_rate",
      event_data: JSON.stringify({ pagingToken: "tok-7" }),
      retry_count: 1,
      max_retries: 3,
    });

    expect(result.outcome).toBe("retrying");
    expect(result.retryCount).toBe(2);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain("status = 'retrying'");
    expect(sql).toContain("next_attempt_at = $3");
    expect(params[0]).toBe(7);
    expect(params[1]).toBe(2);
    expect(params[3]).toBe("handler boom");
    expect(params[2].getTime()).toBeGreaterThan(Date.now());
  });

  test("retryDLQEntry quarantines a poison message that exhausts its retry budget", async () => {
    logger.info.mockImplementationOnce(() => {
      throw new Error("still broken");
    });

    const result = await retryDLQEntry({
      id: 9,
      event_type: "co2_rate",
      event_data: JSON.stringify({ pagingToken: "tok-9" }),
      retry_count: 2,
      max_retries: 3,
    });

    expect(result).toEqual({ outcome: "quarantined", retryCount: 3 });
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain("status = 'quarantined'");
    expect(sql).toContain("quarantined_at = NOW()");
    expect(params).toEqual([9, 3]);
  });

  test("retryDLQEntry quarantines an entry whose event data cannot be decoded", async () => {
    const result = await retryDLQEntry({
      id: 11,
      event_type: "donated",
      event_data: "not-json{",
      retry_count: 1,
      max_retries: 3,
    });

    expect(result).toEqual({ outcome: "quarantined", retryCount: 3 });
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain("status = 'quarantined'");
    expect(params[1]).toBe(3);
  });

  test("pollDLQ re-attempts eligible entries and returns a per-outcome summary", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          event_type: "co2_rate",
          event_data: JSON.stringify({ pagingToken: "tok-1" }),
          retry_count: 0,
          max_retries: 3,
        },
        {
          id: 2,
          event_type: "donated",
          event_data: "not-json{",
          retry_count: 2,
          max_retries: 3,
        },
      ],
    });

    const summary = await pollDLQ();

    expect(summary).toEqual({ processed: 2, resolved: 1, retrying: 0, quarantined: 1 });
    const selectCall = pool.query.mock.calls[0];
    expect(selectCall[0]).toContain("FROM soroban_event_dlq");
    expect(selectCall[0]).toContain("retry_count < max_retries");
    expect(selectCall[0]).toContain("next_attempt_at <= NOW()");
    expect(selectCall[1]).toEqual([10]);
  });
});
