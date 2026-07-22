"use strict";

const mockQuery = jest.fn();
jest.mock("../db/pool", () => ({ query: mockQuery }));

jest.mock("../logger", () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
}));

const mockOn = jest.fn();
const mockStart = jest.fn().mockResolvedValue(undefined);
const mockSchedule = jest.fn().mockResolvedValue(undefined);
const mockWork = jest.fn().mockResolvedValue(undefined);
const mockStop = jest.fn().mockResolvedValue(undefined);

jest.mock("pg-boss", () =>
  jest.fn().mockImplementation(() => ({
    on: mockOn,
    start: mockStart,
    schedule: mockSchedule,
    work: mockWork,
    stop: mockStop,
  })),
);

const logger = require("../logger");

/**
 * `idempotencyCleanup` keeps its pg-boss instance in module-level state,
 * so each test needs a fully isolated require to avoid state leaks.
 */
function loadCleanup() {
  let mod = {};
  jest.isolateModules(() => {
    mod.pool = require("../db/pool");
    mod.logger = require("../logger");
    mod.idempotencyCleanup = require("./idempotencyCleanup");
  });
  return mod;
}

describe("idempotencyCleanup", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.IDEMPOTENCY_CLEANUP_CRON;
  });

  describe("start()", () => {
    test("registers a cron schedule and a worker", async () => {
      const { idempotencyCleanup } = loadCleanup();
      await idempotencyCleanup.start();

      expect(mockStart).toHaveBeenCalledTimes(1);
      expect(mockSchedule).toHaveBeenCalledWith(
        "idempotency-cleanup",
        "5 * * * *",
        {},
        { tz: "UTC" },
      );
      expect(mockWork).toHaveBeenCalledWith(
        "idempotency-cleanup",
        { teamSize: 1, teamConcurrency: 1 },
        expect.any(Function),
      );
    });

    test("respects the IDEMPOTENCY_CLEANUP_CRON env override", async () => {
      process.env.IDEMPOTENCY_CLEANUP_CRON = "0 */6 * * *";
      const { idempotencyCleanup } = loadCleanup();
      await idempotencyCleanup.start();

      expect(mockSchedule).toHaveBeenCalledWith(
        "idempotency-cleanup",
        "0 */6 * * *",
        {},
        { tz: "UTC" },
      );
    });

    test("does nothing when IDEMPOTENCY_CLEANUP_CRON is set to 'disabled'", async () => {
      process.env.IDEMPOTENCY_CLEANUP_CRON = "disabled";
      const { idempotencyCleanup } = loadCleanup();
      await idempotencyCleanup.start();

      expect(mockStart).not.toHaveBeenCalled();
      expect(mockSchedule).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        { event: "idempotency_cleanup_disabled" },
        "[idempotencyCleanup] Cleanup disabled via env",
      );
    });
  });

  describe("stop()", () => {
    test("is a no-op when the queue was never started", async () => {
      const { idempotencyCleanup } = loadCleanup();
      await idempotencyCleanup.stop();
      expect(mockStop).not.toHaveBeenCalled();
    });

    test("gracefully stops pg-boss once started", async () => {
      const { idempotencyCleanup } = loadCleanup();
      await idempotencyCleanup.start();
      await idempotencyCleanup.stop();
      expect(mockStop).toHaveBeenCalledWith({ timeout: 5000 });
    });
  });

  describe("worker handler (runCleanup)", () => {
    async function getWorkerHandler({ clearAfterStart } = {}) {
      const { idempotencyCleanup, pool, logger } = loadCleanup();
      await idempotencyCleanup.start();
      const handler = mockWork.mock.calls[0][2];
      // Reset mocks so assertions only capture calls made by the handler,
      // not the start() / schedule() lifecycle logs.
      if (clearAfterStart) {
        logger.info.mockClear();
        pool.query.mockClear();
      }
      return { handler, pool, logger };
    }

    test("executes the DELETE query against idempotency_keys", async () => {
      const { handler, pool } = await getWorkerHandler({ clearAfterStart: true });
      pool.query.mockResolvedValueOnce({ rowCount: 3 });

      await handler();

      expect(pool.query).toHaveBeenCalledTimes(1);
      const [sql] = pool.query.mock.calls[0];
      expect(sql).toContain("DELETE FROM idempotency_keys");
      expect(sql).toContain("expires_at < NOW()");
    });

    test("logs when expired rows are purged", async () => {
      const { handler, pool, logger } = await getWorkerHandler({ clearAfterStart: true });
      pool.query.mockResolvedValueOnce({ rowCount: 7 });

      await handler();

      expect(logger.info).toHaveBeenCalledWith(
        { event: "idempotency_cleanup", deleted: 7 },
        "Purged 7 expired idempotency key(s)",
      );
    });

    test("does not log when no rows are deleted", async () => {
      const { handler, pool, logger } = await getWorkerHandler({ clearAfterStart: true });
      pool.query.mockResolvedValueOnce({ rowCount: 0 });

      await handler();

      expect(logger.info).not.toHaveBeenCalled();
    });
  });
});
