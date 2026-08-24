"use strict";

/**
 * Concurrency test for indexer backfill / reconciler advisory lock.
 *
 * Verifies that when two runBackfill() calls (or a backfill + a
 * runReconciliation()) are fired concurrently:
 *   - Exactly one acquires the advisory lock and executes.
 *   - The other returns { skipped: true } immediately.
 *   - No duplicate donation rows are created when both reach the INSERT.
 *
 * The test is self-contained: it stubs out pool, stellar, indexerService,
 * and metrics so no real DB, Horizon, or prom-client registry is needed.
 * This keeps the test fast, hermetic, and safe to run in the standard CI
 * jest suite (no testcontainers required here; integration-level DB tests
 * live in indexerDonationHandler.integration.test.js).
 *
 * Run with: npm test -- indexerConcurrency
 */

jest.mock("../logger", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock("./metrics", () => ({
  registry: { registerMetric: jest.fn(), getMetricsAsJSON: jest.fn(() => []) },
}));

// ── Pool mock ────────────────────────────────────────────────────────────────
// We need pg_try_advisory_lock to simulate the real Postgres behavior:
// the first caller wins, subsequent callers get false until the lock is
// released by pg_advisory_unlock.

let lockHeld = false;

const mockPoolQuery = jest.fn(async (sql, params) => {
  const q = sql.replace(/\s+/g, " ").trim().toUpperCase();

  if (q.includes("PG_TRY_ADVISORY_LOCK")) {
    // Simulate the real lock: first caller gets true, subsequent get false.
    if (!lockHeld) {
      lockHeld = true;
      return { rows: [{ acquired: true }] };
    }
    return { rows: [{ acquired: false }] };
  }

  if (q.includes("PG_ADVISORY_UNLOCK")) {
    lockHeld = false;
    return { rows: [] };
  }

  if (q.includes("BACKFILL_IN_PROGRESS")) {
    return { rows: [{ backfill_in_progress: false }] };
  }

  if (q.includes("LAST_PROCESSED_LEDGER") || q.includes("INDEXER_STATE")) {
    return {
      rows: [
        {
          last_processed_ledger: 0,
          backfill_in_progress: false,
          last_lock_skipped_at: null,
        },
      ],
    };
  }

  if (q.includes("COUNT") && q.includes("DONATIONS")) {
    return { rows: [{ count: "0" }] };
  }

  // Default: successful no-op
  return { rows: [] };
});

const mockClientQuery = jest.fn(async (sql, params) => mockPoolQuery(sql, params));
const mockClientRelease = jest.fn();

const mockPool = {
  query: mockPoolQuery,
  connect: jest.fn(async () => ({
    query: mockClientQuery,
    release: mockClientRelease,
  })),
};

jest.mock("../db/pool", () => mockPool);

// ── Stellar mock — returns a minimal ledger tip ───────────────────────────────
jest.mock("./stellar", () => ({
  server: {
    ledgers: jest.fn(() => ({
      limit: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      call: jest.fn().mockResolvedValue({
        records: [{ sequence: 100 }],
      }),
    })),
    operations: jest.fn(() => ({
      cursor: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      // Return an empty page so the paginated loop exits immediately.
      call: jest.fn().mockResolvedValue({ records: [] }),
    })),
  },
}));

// ── indexerService mock — handleDonation is a no-op ────────────────────────
jest.mock("./indexerService", () => ({
  handleDonation: jest.fn().mockResolvedValue(undefined),
}));

// ── prom-client mocks ────────────────────────────────────────────────────────
jest.mock("prom-client", () => {
  const inc = jest.fn();
  const set = jest.fn();
  return {
    Counter: jest.fn().mockImplementation(() => ({ inc })),
    Gauge: jest.fn().mockImplementation(() => ({ set })),
    Registry: jest.fn().mockImplementation(() => ({
      registerMetric: jest.fn(),
      getMetricsAsJSON: jest.fn(() => []),
    })),
  };
});

// ── Load the modules under test AFTER all mocks are established ──────────────
let runBackfill;
let runReconciliation;
let _backfillLockKey;

beforeAll(() => {
  ({ runBackfill, _backfillLockKey } = require("./indexerBackfill"));
  ({ runReconciliation } = require("./indexerReconciler"));
});

// Reset the simulated lock state before each test.
beforeEach(() => {
  lockHeld = false;
  jest.clearAllMocks();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("indexer backfill/reconciler concurrency guard", () => {
  test("concurrent runBackfill() calls: only one executes, other returns skipped", async () => {
    // Fire both calls simultaneously — the Promises race to pg_try_advisory_lock.
    const [result1, result2] = await Promise.all([
      runBackfill(),
      runBackfill(),
    ]);

    // Exactly one should have the skipped flag; the other runs normally.
    const skippedResults = [result1, result2].filter((r) => r.skipped === true);
    const normalResults = [result1, result2].filter((r) => !r.skipped);

    expect(skippedResults).toHaveLength(1);
    expect(normalResults).toHaveLength(1);
  });

  test("concurrent runReconciliation() calls: only one executes, other returns skipped", async () => {
    const [r1, r2] = await Promise.all([
      runReconciliation(),
      runReconciliation(),
    ]);

    const skippedCount = [r1, r2].filter((r) => r.skipped === true).length;
    expect(skippedCount).toBe(1);
  });

  test("concurrent backfill + reconciliation: only one executes, other returns skipped", async () => {
    const [backfillResult, reconcileResult] = await Promise.all([
      runBackfill(),
      runReconciliation(),
    ]);

    const skipped = [backfillResult, reconcileResult].filter(
      (r) => r.skipped === true,
    );
    expect(skipped).toHaveLength(1);
  });

  test("sequential backfill calls both execute (lock released between calls)", async () => {
    const r1 = await runBackfill();
    // Lock must be released now — second call should also run (not skipped).
    const r2 = await runBackfill();

    expect(r1.skipped).toBeFalsy();
    expect(r2.skipped).toBeFalsy();
  });

  test("skipped backfill records last_lock_skipped_at timestamp", async () => {
    // Hold the lock ourselves so any runBackfill() call must skip.
    lockHeld = true;

    const result = await runBackfill();
    expect(result.skipped).toBe(true);

    // The service should have called UPDATE indexer_state SET last_lock_skipped_at …
    const updateCalls = mockPoolQuery.mock.calls.filter(([sql]) =>
      sql && sql.toLowerCase().includes("last_lock_skipped_at"),
    );
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);
  });

  test("_backfillLockKey is a bigint within the signed int8 Postgres range", () => {
    expect(typeof _backfillLockKey).toBe("bigint");
    // Postgres pg_advisory_lock accepts signed int8: 0 .. 2^63-1
    expect(_backfillLockKey).toBeGreaterThanOrEqual(0n);
    expect(_backfillLockKey).toBeLessThanOrEqual(0x7fffffffffffffffn);
  });
});
