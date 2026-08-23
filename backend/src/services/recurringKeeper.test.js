"use strict";

/**
 * src/services/recurringKeeper.test.js
 *
 * Verifies the recurring keeper cycle is guarded by a per-worker advisory lock
 * (issue #677). The lock semantics themselves are exercised in
 * advisoryLock.test.js; here we only assert the wiring.
 */

jest.mock("../db/pool", () => ({
  query: jest.fn(),
}));

jest.mock("../logger", () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

jest.mock("./stellar", () => ({
  CONTRACT_ID: "",
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  server: { loadAccount: jest.fn() },
  submitTransaction: jest.fn(),
  simulateTransactionWithRetry: jest.fn(),
}));

jest.mock("./metrics", () => ({
  metrics: {
    recurringPending: { set: jest.fn() },
    recurringExecutionsTotal: { inc: jest.fn() },
  },
}));

jest.mock("./advisoryLock", () => ({
  LOCK_KEYS: { recurringKeeper: "worker:recurring_keeper" },
  withAdvisoryLock: jest.fn(),
}));

const recurringKeeper = require("./recurringKeeper");
const { withAdvisoryLock, LOCK_KEYS } = require("./advisoryLock");

describe("runKeeperCycleWithLock", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("acquires the recurring-keeper advisory lock around the cycle", async () => {
    withAdvisoryLock.mockResolvedValueOnce(true);

    const result = await recurringKeeper.runKeeperCycleWithLock();

    expect(result).toBe(true);
    expect(withAdvisoryLock).toHaveBeenCalledWith(
      LOCK_KEYS.recurringKeeper,
      recurringKeeper.runKeeperCycle,
    );
  });

  test("returns false without running the cycle when the lock is not acquired", async () => {
    withAdvisoryLock.mockResolvedValueOnce(false);

    const result = await recurringKeeper.runKeeperCycleWithLock();

    expect(result).toBe(false);
    expect(withAdvisoryLock).toHaveBeenCalledTimes(1);
  });
});
