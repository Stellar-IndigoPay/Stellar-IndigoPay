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
  };
});

// Mock stellar service
jest.mock("../../src/services/stellar", () => ({
  CONTRACT_ID: "test-contract-id",
  NETWORK_PASSPHRASE: "test-passphrase",
  submitTransaction: jest.fn(),
  simulateTransactionWithRetry: jest.fn(),
  server: {
    loadAccount: jest.fn(),
  },
}));

const pool = require("../../src/db/pool");
const { submitTransaction, simulateTransactionWithRetry, server } = require("../../src/services/stellar");
const { metrics } = require("../../src/services/metrics");
const recurringKeeper = require("../../src/services/recurringKeeper");

describe("recurringKeeper Service", () => {
  const mockKeeperSecret = "S1234567890123456789012345678901234567890123456789012345";

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.KEEPER_SECRET = mockKeeperSecret;
    process.env.CONTRACT_ID = "test-contract-id";
  });

  afterEach(async () => {
    await recurringKeeper.stop();
  });

  test("skips cycle if KEEPER_SECRET is missing", async () => {
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
    const mockSchedule = {
      donor_address: "GDONORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      recurring_id: 1,
      project_id: "proj-1",
      amount: "10.0000000",
      currency: "XLM",
      keeper_incentive: "0.5000000",
    };

    pool.query.mockResolvedValueOnce({ rows: [mockSchedule] });
    
    const mockAccount = {
      incrementSequenceNumber: jest.fn(),
    };
    server.loadAccount.mockResolvedValueOnce(mockAccount);
    simulateTransactionWithRetry.mockResolvedValueOnce({ error: null, result: { retval: {} } });
    submitTransaction.mockResolvedValueOnce({ hash: "tx-hash-1" });

    // Initialize metrics gauges
    metrics.recurringPending = { set: jest.fn() };
    metrics.recurringExecutionsTotal = { inc: jest.fn() };

    // Trigger cycle
    await recurringKeeper.runKeeperCycle();

    // Verify DB fetch
    expect(pool.query).toHaveBeenCalled();
    expect(server.loadAccount).toHaveBeenCalledWith("GKEYPAIR");
    expect(simulateTransactionWithRetry).toHaveBeenCalled();
    expect(submitTransaction).toHaveBeenCalledWith("mock-xdr");
    expect(mockAccount.incrementSequenceNumber).toHaveBeenCalled();
    expect(metrics.recurringPending.set).toHaveBeenCalledWith(1);
    expect(metrics.recurringExecutionsTotal.inc).toHaveBeenCalledWith({ status: "success" });
  });

  test("handles simulation failure correctly", async () => {
    const mockSchedule = {
      donor_address: "GDONORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      recurring_id: 2,
      project_id: "proj-2",
      amount: "20.0000000",
      currency: "USDC",
      keeper_incentive: "0.5000000",
    };

    pool.query.mockResolvedValueOnce({ rows: [mockSchedule] });
    
    const mockAccount = {
      incrementSequenceNumber: jest.fn(),
    };
    server.loadAccount.mockResolvedValueOnce(mockAccount);
    
    // Mock simulation failure
    const { rpc } = require("@stellar/stellar-sdk");
    rpc.Api.isSimulationSuccess.mockReturnValueOnce(false);
    simulateTransactionWithRetry.mockResolvedValueOnce({ error: "low allowance" });

    metrics.recurringPending = { set: jest.fn() };
    metrics.recurringExecutionsTotal = { inc: jest.fn() };

    await recurringKeeper.runKeeperCycle();

    expect(submitTransaction).not.toHaveBeenCalled();
    expect(metrics.recurringExecutionsTotal.inc).toHaveBeenCalledWith({ status: "failed" });
  });
});
