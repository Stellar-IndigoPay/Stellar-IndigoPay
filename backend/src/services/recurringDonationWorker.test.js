"use strict";

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

const mockGetLatestLedger = jest.fn();
const mockSimulate = jest.fn();
const mockLoadAccount = jest.fn();
const mockGetOnChainProject = jest.fn();

jest.mock("./stellar", () => ({
  rpcServer: { getLatestLedger: (...args) => mockGetLatestLedger(...args) },
  server: { loadAccount: (...args) => mockLoadAccount(...args) },
  CONTRACT_ID: "CCONTRACTIDFAKE",
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  simulateTransactionWithRetry: (...args) => mockSimulate(...args),
  getOnChainProject: (...args) => mockGetOnChainProject(...args),
}));

const mockEnqueuePushNotification = jest.fn().mockResolvedValue("job-id");
jest.mock("./pushQueue", () => ({
  enqueuePushNotification: (...args) => mockEnqueuePushNotification(...args),
}));

// Lightweight stand-ins for the pieces of @stellar/stellar-sdk this worker
// uses. `nativeToScVal` / `scValToNative` are identity functions here, so
// tests can hand back plain JS values as the "decoded" simulation result
// instead of constructing real XDR.
jest.mock("@stellar/stellar-sdk", () => ({
  Horizon: {
    Account: jest.fn().mockImplementation((id, seq) => ({ id, seq })),
  },
  Contract: jest.fn().mockImplementation((id) => ({
    call: jest.fn((method, ...args) => ({ __contractId: id, method, args })),
  })),
  TransactionBuilder: jest.fn().mockImplementation(() => ({
    addOperation: jest.fn().mockReturnThis(),
    setTimeout: jest.fn().mockReturnThis(),
    build: jest.fn().mockReturnValue({ toXDR: () => "FAKE_TX_XDR" }),
  })),
  nativeToScVal: jest.fn((val) => val),
  scValToNative: jest.fn((val) => val),
  Asset: {
    native: jest.fn().mockReturnValue({
      contractId: jest.fn().mockReturnValue("NATIVE_XLM_CONTRACT_ID"),
    }),
  },
  rpc: { Api: { isSimulationSuccess: jest.fn() } },
}));

const { rpc } = require("@stellar/stellar-sdk");

/**
 * `recurringDonationWorker` keeps its pg-boss instance and de-dupe Set in
 * module-level state, so each test needs a fully isolated require —
 * otherwise the de-dupe Set (and stale boss references) would leak
 * between tests, same reasoning as pushQueue.test.js's loadPushQueue().
 */
function loadWorker() {
  let mod = {};
  jest.isolateModules(() => {
    mod.worker = require("./recurringDonationWorker");
  });
  return mod;
}

function subscription(overrides = {}) {
  return {
    donor: "GDONORAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    project_id: "proj-001",
    amount: 10_000_000n,
    interval_ledgers: 17280,
    next_execution: 100,
    active: true,
    created_at: 50,
    ...overrides,
  };
}

/** Queue up the two simulate() calls checkDueSubscriptions makes per tick:
 * one for get_subscription_count, then one get_subscription_by_index per
 * subscription in `subs`. */
function mockChainState({ latestLedger = 200, subs = [] }) {
  mockGetLatestLedger.mockResolvedValue({ sequence: latestLedger });
  rpc.Api.isSimulationSuccess.mockReturnValue(true);
  mockSimulate.mockResolvedValueOnce({ result: { retval: subs.length } });
  for (const sub of subs) {
    mockSimulate.mockResolvedValueOnce({ result: { retval: sub } });
  }
}

describe("recurringDonationWorker", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetOnChainProject.mockResolvedValue({ name: "Test Project" });
    mockLoadAccount.mockResolvedValue({ accountId: () => "GDONOR" });
  });

  test("notifies via WebSocket and push for a due, active subscription", async () => {
    const { worker } = loadWorker();
    const sub = subscription({ next_execution: 100 });
    mockChainState({ latestLedger: 150, subs: [sub] });
    const io = { emit: jest.fn() };

    await worker.checkDueSubscriptions(io);

    expect(io.emit).toHaveBeenCalledWith(
      "recurring_due",
      expect.objectContaining({
        donor: sub.donor,
        projectId: sub.project_id,
        prebuiltTransactionXDR: "FAKE_TX_XDR",
      }),
    );
    expect(mockEnqueuePushNotification).toHaveBeenCalledWith({
      type: "recurring_reminder",
      payload: expect.objectContaining({
        donorAddress: sub.donor,
        projectId: sub.project_id,
        projectName: "Test Project",
        currency: "XLM",
      }),
    });
  });

  test("skips a subscription that isn't due yet", async () => {
    const { worker } = loadWorker();
    const sub = subscription({ next_execution: 500 });
    mockChainState({ latestLedger: 150, subs: [sub] });
    const io = { emit: jest.fn() };

    await worker.checkDueSubscriptions(io);

    expect(io.emit).not.toHaveBeenCalled();
    expect(mockEnqueuePushNotification).not.toHaveBeenCalled();
  });

  test("skips an inactive subscription even if its next_execution has passed", async () => {
    const { worker } = loadWorker();
    const sub = subscription({ next_execution: 100, active: false });
    mockChainState({ latestLedger: 150, subs: [sub] });
    const io = { emit: jest.fn() };

    await worker.checkDueSubscriptions(io);

    expect(io.emit).not.toHaveBeenCalled();
    expect(mockEnqueuePushNotification).not.toHaveBeenCalled();
  });

  test("does not re-notify the same due tick on a second pass", async () => {
    const { worker } = loadWorker();
    const sub = subscription({ next_execution: 100 });
    const io = { emit: jest.fn() };

    mockChainState({ latestLedger: 150, subs: [sub] });
    await worker.checkDueSubscriptions(io);
    expect(io.emit).toHaveBeenCalledTimes(1);

    // Second tick: same subscription, same next_execution — already
    // notified, so no second WebSocket emit or push enqueue.
    mockChainState({ latestLedger: 155, subs: [sub] });
    await worker.checkDueSubscriptions(io);

    expect(io.emit).toHaveBeenCalledTimes(1);
    expect(mockEnqueuePushNotification).toHaveBeenCalledTimes(1);
  });

  test("continues past a subscription whose index read fails", async () => {
    const { worker } = loadWorker();
    const goodSub = subscription({ next_execution: 100 });
    mockGetLatestLedger.mockResolvedValue({ sequence: 150 });
    rpc.Api.isSimulationSuccess.mockReturnValue(true);
    // count = 2
    mockSimulate.mockResolvedValueOnce({ result: { retval: 2 } });
    // index 0 read throws
    mockSimulate.mockRejectedValueOnce(new Error("rpc timeout"));
    // index 1 succeeds
    mockSimulate.mockResolvedValueOnce({ result: { retval: goodSub } });
    const io = { emit: jest.fn() };

    await worker.checkDueSubscriptions(io);

    expect(io.emit).toHaveBeenCalledTimes(1);
    expect(io.emit).toHaveBeenCalledWith(
      "recurring_due",
      expect.objectContaining({ donor: goodSub.donor }),
    );
  });

  test("returns without emitting when the latest ledger can't be fetched", async () => {
    const { worker } = loadWorker();
    mockGetLatestLedger.mockRejectedValue(new Error("rpc down"));
    const io = { emit: jest.fn() };

    await worker.checkDueSubscriptions(io);

    expect(io.emit).not.toHaveBeenCalled();
    expect(mockSimulate).not.toHaveBeenCalled();
  });

  test("still emits recurring_due when the tx template can't be built", async () => {
    const { worker } = loadWorker();
    const sub = subscription({ next_execution: 100 });
    mockChainState({ latestLedger: 150, subs: [sub] });
    mockLoadAccount.mockRejectedValue(new Error("account not found"));
    const io = { emit: jest.fn() };

    await worker.checkDueSubscriptions(io);

    expect(io.emit).toHaveBeenCalledWith(
      "recurring_due",
      expect.objectContaining({ prebuiltTransactionXDR: null }),
    );
  });

  test("a push enqueue failure doesn't stop the WebSocket notification", async () => {
    const { worker } = loadWorker();
    const sub = subscription({ next_execution: 100 });
    mockChainState({ latestLedger: 150, subs: [sub] });
    mockEnqueuePushNotification.mockRejectedValueOnce(
      new Error("pushQueue not started"),
    );
    const io = { emit: jest.fn() };

    await expect(worker.checkDueSubscriptions(io)).resolves.not.toThrow();
    expect(io.emit).toHaveBeenCalledTimes(1);
  });

  test("start() is a no-op when RECURRING_DONATION_CRON=disabled", async () => {
    const { worker } = loadWorker();
    const original = process.env.RECURRING_DONATION_CRON;
    process.env.RECURRING_DONATION_CRON = "disabled";

    await worker.start({ emit: jest.fn() });

    expect(mockStart).not.toHaveBeenCalled();
    process.env.RECURRING_DONATION_CRON = original;
  });

  test("start() schedules the default 5-minute cron and registers a worker", async () => {
    const { worker } = loadWorker();
    delete process.env.RECURRING_DONATION_CRON;

    await worker.start({ emit: jest.fn() });

    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(mockSchedule).toHaveBeenCalledWith(
      worker.QUEUE,
      "*/5 * * * *",
      {},
      { tz: "UTC" },
    );
    expect(mockWork).toHaveBeenCalledWith(
      worker.QUEUE,
      { teamSize: 1, teamConcurrency: 1 },
      expect.any(Function),
    );
  });

  test("stop() gracefully stops pg-boss after start() was called", async () => {
    const { worker } = loadWorker();
    delete process.env.RECURRING_DONATION_CRON;

    await worker.start({ emit: jest.fn() });
    await worker.stop();

    expect(mockStop).toHaveBeenCalledWith({ graceful: true, timeout: 15_000 });
  });

  test("stop() is a no-op if start() was never called", async () => {
    const { worker } = loadWorker();
    await worker.stop();
    expect(mockStop).not.toHaveBeenCalled();
  });
});
