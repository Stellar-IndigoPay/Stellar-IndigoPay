/**
 * __tests__/services/recurringKeeper.test.js
 *
 * Unit tests for the recurring donation keeper service.
 */
"use strict";

jest.mock("../../src/db/pool", () => ({
  query: jest.fn(),
}));

jest.mock("../../src/logger", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

// Mock @stellar/stellar-sdk
jest.mock("@stellar/stellar-sdk", () => {
  const mockAddress = {
    toString: () => "GADDRESS",
    toScVal: () => ({}),
  };
  const mockContract = {
    call: jest.fn().mockReturnValue({}),
  };
  const mockTx = {
    setTimeout: jest.fn().mockReturnThis(),
    build: jest.fn().mockReturnThis(),
    sign: jest.fn(),
    toXDR: jest.fn().mockReturnValue("mock-xdr"),
  };
  const mockTxBuilder = jest.fn().mockImplementation(() => ({
    addOperation: jest.fn().mockReturnThis(),
    setTimeout: jest.fn().mockReturnThis(),
    build: jest.fn().mockReturnValue(mockTx),
  }));

  return {
    Contract: jest.fn().mockImplementation(() => mockContract),
    Address: {
      fromString: jest.fn().mockReturnValue(mockAddress),
    },
    Keypair: {
      fromSecret: jest.fn().mockReturnValue({
        publicKey: () => "GKEYPAIR",
        sign: jest.fn(),
      }),
    },
    TransactionBuilder: mockTxBuilder,
    nativeToScVal: jest.fn().mockReturnValue({}),
    rpc: {
      Api: {
        isSimulationSuccess: jest.fn().mockReturnValue(true),
      },
      assembleTransaction: jest.fn().mockReturnValue({
        build: jest.fn().mockReturnValue(mockTx),
      }),
    },
    Networks: {
      TESTNET: "testnet",
      PUBLIC: "public",
    },
  };
});

// Mock stellar service
jest.mock("../../src/services/stellar", () => {
  return {
    CONTRACT_ID: "test-contract-id",
    NETWORK_PASSPHRASE: "test-passphrase",
    submitTransaction: jest.fn(),
    submitWithFeeBump: jest.fn().mockResolvedValue({ hash: "mock-hash", successful: true }),
    simulateTransactionWithRetry: jest.fn(),
    server: {
      loadAccount: jest.fn(),
    },
  };
});

const pool = require("../../src/db/pool");
const { submitTransaction, submitWithFeeBump, simulateTransactionWithRetry, server } = require("../../src/services/stellar");
const { TransactionBuilder } = require("@stellar/stellar-sdk");
const { metrics } = require("../../src/services/metrics");
const recurringKeeper = require("../../src/services/recurringKeeper");

/** The account each TransactionBuilder was constructed with, in build order. */
function builtAccounts() {
  return TransactionBuilder.mock.calls.map(([account]) => account);
}

/** Keeper account snapshot whose sequence can be read back per load. */
function account(seq) {
  return {
    sequenceNumber: () => seq,
    incrementSequenceNumber: jest.fn(),
  };
}

function dueSchedule(overrides = {}) {
  return {
    donor_address: "GDONORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    recurring_id: 1,
    project_id: "proj-1",
    amount: "10.0000000",
    currency: "XLM",
    keeper_incentive: "0.5000000",
    ...overrides,
  };
}

describe("recurringKeeper Service", () => {
  const mockKeeperSecret = "S1234567890123456789012345678901234567890123456789012345";

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NODE_ENV = "test";
    process.env.KEEPER_SECRET = mockKeeperSecret;
    process.env.CONTRACT_ID = "test-contract-id";
    metrics.recurringPending = { set: jest.fn() };
    metrics.recurringExecutionsTotal = { inc: jest.fn() };
  });

  afterEach(async () => {
    await recurringKeeper.stop();
  });

  test("skips cycle if managed keeper signing secret is missing", async () => {
    delete process.env.KEEPER_SECRET;
    
    await recurringKeeper.runKeeperCycle();
    
    expect(pool.query).not.toHaveBeenCalled();
  });

  test("skips cycle if CONTRACT_ID is missing", async () => {
    delete process.env.CONTRACT_ID;
    
    await recurringKeeper.runKeeperCycle();
    
    expect(pool.query).not.toHaveBeenCalled();
  });

  test("does nothing if no schedules are due", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    
    await recurringKeeper.runKeeperCycle();
    
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("SELECT"));
    expect(server.loadAccount).not.toHaveBeenCalled();
  });

  test("executes matured recurring donation schedule successfully", async () => {
    pool.query.mockResolvedValueOnce({ rows: [dueSchedule()] });

    // One load for the cycle check, then a fresh load for the submission.
    server.loadAccount
      .mockResolvedValueOnce(account(100))
      .mockResolvedValueOnce(account(100));
    simulateTransactionWithRetry.mockResolvedValueOnce({ error: null, result: { retval: {} } });
    submitWithFeeBump.mockResolvedValueOnce({ hash: "tx-hash-1" });

    // Trigger cycle
    await recurringKeeper.runKeeperCycle();

    // Verify DB fetch
    expect(pool.query).toHaveBeenCalled();
    expect(server.loadAccount).toHaveBeenCalledWith("GKEYPAIR");
    expect(simulateTransactionWithRetry).toHaveBeenCalled();
    expect(submitWithFeeBump).toHaveBeenCalledWith(expect.anything(), expect.anything());
    expect(builtAccounts().map((a) => a.sequenceNumber())).toEqual([100]);
    expect(metrics.recurringPending.set).toHaveBeenCalledWith(1);
    expect(metrics.recurringExecutionsTotal.inc).toHaveBeenCalledWith({ status: "success" });
  });

  test("reloads the keeper account before every submission so sequences are never stale", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [dueSchedule({ recurring_id: 1 }), dueSchedule({ recurring_id: 2 })],
    });

    // Sequence advances to 103 between submissions — as if an external
    // transaction bumped the keeper account. Each transaction must therefore
    // be built from a freshly loaded account, not a stale snapshot.
    server.loadAccount
      .mockResolvedValueOnce(account(100))
      .mockResolvedValueOnce(account(100))
      .mockResolvedValueOnce(account(103));
    simulateTransactionWithRetry.mockResolvedValue({ error: null, result: { retval: {} } });
    submitWithFeeBump.mockResolvedValue({ hash: "tx-hash" });

    await recurringKeeper.runKeeperCycle();

    // One load up front + one per schedule; never reuses a stale snapshot.
    expect(server.loadAccount).toHaveBeenCalledTimes(3);
    expect(submitWithFeeBump).toHaveBeenCalledTimes(2);
    expect(builtAccounts().map((a) => a.sequenceNumber())).toEqual([100, 103]);
    expect(metrics.recurringExecutionsTotal.inc).toHaveBeenCalledWith({ status: "success" });
  });

  test("keeps going with a freshly reloaded account after a submission failure", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [dueSchedule({ recurring_id: 1 }), dueSchedule({ recurring_id: 2 })],
    });

    server.loadAccount
      .mockResolvedValueOnce(account(100))
      .mockResolvedValueOnce(account(100))
      .mockResolvedValueOnce(account(101));
    simulateTransactionWithRetry.mockResolvedValue({ error: null, result: { retval: {} } });
    // First submission fails (e.g. tx_bad_seq from an external bump); the
    // second must still run against a reloaded, current sequence.
    submitWithFeeBump
      .mockRejectedValueOnce(new Error("Transaction failed: tx_bad_seq"))
      .mockResolvedValueOnce({ hash: "tx-hash-2" });

    await recurringKeeper.runKeeperCycle();

    expect(submitWithFeeBump).toHaveBeenCalledTimes(2);
    expect(builtAccounts().map((a) => a.sequenceNumber())).toEqual([100, 101]);
    expect(metrics.recurringExecutionsTotal.inc).toHaveBeenCalledWith({ status: "failed" });
    expect(metrics.recurringExecutionsTotal.inc).toHaveBeenCalledWith({ status: "success" });
  });

  test("handles simulation failure correctly", async () => {
    pool.query.mockResolvedValueOnce({ rows: [dueSchedule({ recurring_id: 2 })] });
    
    server.loadAccount
      .mockResolvedValueOnce(account(100))
      .mockResolvedValueOnce(account(100));
    
    // Mock simulation failure
    const { rpc } = require("@stellar/stellar-sdk");
    rpc.Api.isSimulationSuccess.mockReturnValueOnce(false);
    simulateTransactionWithRetry.mockResolvedValueOnce({ error: "low allowance" });

    await recurringKeeper.runKeeperCycle();

    expect(submitWithFeeBump).not.toHaveBeenCalled();
    expect(metrics.recurringExecutionsTotal.inc).toHaveBeenCalledWith({ status: "failed" });
  });
});