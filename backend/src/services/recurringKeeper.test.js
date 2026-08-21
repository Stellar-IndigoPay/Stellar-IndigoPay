"use strict";

/**
 * Issue #931: graceful shutdown / drain semantics.
 *
 * `recurringKeeper.stop()` used to `clearInterval` and return immediately,
 * even while a keeper cycle triggered by that interval (or the initial
 * on-start cycle) was still mid-flight submitting on-chain transactions.
 * These tests simulate a SIGTERM landing mid-cycle and assert `stop()`
 * now waits for that cycle to finish before resolving.
 */

jest.mock("../db/pool", () => ({
  query: jest.fn(),
}));

jest.mock("../logger", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock("./metrics", () => ({
  metrics: {
    recurringPending: { set: jest.fn() },
    recurringExecutionsTotal: { inc: jest.fn() },
    workerDraining: { set: jest.fn() },
  },
}));

const mockGetSigningSecret = jest.fn();
jest.mock("./signingSecretProvider", () => ({
  getSigningSecret: (...args) => mockGetSigningSecret(...args),
}));

jest.mock("./stellar", () => ({
  server: { loadAccount: jest.fn() },
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  submitTransaction: jest.fn(),
  simulateTransactionWithRetry: jest.fn(),
}));

jest.mock("@stellar/stellar-sdk", () => ({
  Contract: jest.fn(),
  Address: { fromString: jest.fn() },
  Keypair: { fromSecret: jest.fn() },
  TransactionBuilder: jest.fn(),
  nativeToScVal: jest.fn(),
  rpc: { Api: { isSimulationSuccess: jest.fn() } },
}));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * `recurringKeeper` keeps its interval id and drain controller in
 * module-level state, so each test needs a fully isolated require.
 */
function loadKeeper() {
  let mod;
  jest.isolateModules(() => {
    mod = require("./recurringKeeper");
  });
  return mod;
}

describe("recurringKeeper graceful shutdown", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  test("stop() waits for an in-flight keeper cycle to finish before resolving", async () => {
    const secret = deferred();
    mockGetSigningSecret.mockReturnValue(secret.promise);

    const keeper = loadKeeper();
    await keeper.start();

    // Let the initial on-start cycle reach (and hang at) getSigningSecret.
    await Promise.resolve();
    await Promise.resolve();
    expect(keeper._drain.getInFlightCount()).toBe(1);
    expect(keeper._drain.getState()).toBe("running");

    let stopResolved = false;
    const stopPromise = keeper.stop().then(() => {
      stopResolved = true;
    });

    // stop() must not resolve while the cycle is still in flight.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(stopResolved).toBe(false);
    expect(keeper._drain.getState()).toBe("draining");

    // The in-flight cycle finishes (secret lookup fails softly and the
    // cycle returns without throwing — see recurringKeeper.js's catch).
    secret.reject(new Error("no signing secret configured"));

    await stopPromise;
    expect(stopResolved).toBe(true);
    expect(keeper._drain.getInFlightCount()).toBe(0);
    expect(keeper._drain.getState()).toBe("drained");
  });

  test("stop() resolves immediately when no cycle is in flight", async () => {
    // Resolve fast so the initial cycle isn't still running when stop() is
    // called moments later.
    mockGetSigningSecret.mockRejectedValue(new Error("no secret"));

    const keeper = loadKeeper();
    await keeper.start();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    await keeper.stop();
    expect(keeper._drain.getState()).toBe("drained");
    expect(keeper._drain.getInFlightCount()).toBe(0);
  });

  test("stop() force-drains after the grace period if a cycle never finishes", async () => {
    jest.useFakeTimers();
    try {
      // A cycle that hangs forever — simulates a stuck on-chain
      // submission that can't be safely interrupted.
      mockGetSigningSecret.mockReturnValue(new Promise(() => {}));

      const keeper = loadKeeper();
      await keeper.start();
      await Promise.resolve();
      await Promise.resolve();
      expect(keeper._drain.getInFlightCount()).toBe(1);

      const stopPromise = keeper.stop();
      await jest.advanceTimersByTimeAsync(30_000);

      await stopPromise;
      expect(keeper._drain.getState()).toBe("drained");
      // The stuck cycle is still counted in-flight — force-draining
      // doesn't cancel it, it just stops the process from waiting on it
      // forever. Recovery is the job model's responsibility once the
      // process exits (documented in issue #931's edge cases).
      expect(keeper._drain.getInFlightCount()).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
