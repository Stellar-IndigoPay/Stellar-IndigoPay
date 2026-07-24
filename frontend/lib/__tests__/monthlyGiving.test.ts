/**
 * lib/__tests__/monthlyGiving.test.ts
 *
 * Covers the on-chain recurring donation subscription helpers (#81):
 * reading a single subscription, enumerating due subscriptions for a
 * donor, and the create/cancel sign-and-submit flows.
 */
const mockLoadAccount = jest.fn();
const mockSimulateTransaction = jest.fn();
const mockGetLatestLedger = jest.fn();
const mockSubmitSorobanTransaction = jest.fn();

jest.mock("@/lib/stellar", () => ({
  server: { loadAccount: (...args: any[]) => mockLoadAccount(...args) },
  rpcServer: {
    simulateTransaction: (...args: any[]) => mockSimulateTransaction(...args),
    getLatestLedger: (...args: any[]) => mockGetLatestLedger(...args),
  },
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  CONTRACT_ID: "CCONTRACTIDFAKE",
  submitSorobanTransaction: (...args: any[]) =>
    mockSubmitSorobanTransaction(...args),
}));

const mockSignTransactionWithWallet = jest.fn();
jest.mock("@/lib/wallet", () => ({
  signTransactionWithWallet: (...args: any[]) =>
    mockSignTransactionWithWallet(...args),
}));

// Lightweight stand-ins for the pieces of @stellar/stellar-sdk this module
// uses. `nativeToScVal` / `scValToNative` are identity functions, so tests
// hand back plain JS values as the "decoded" simulation result instead of
// constructing real XDR.
jest.mock("@stellar/stellar-sdk", () => ({
  Contract: jest.fn().mockImplementation((id: string) => ({
    call: jest.fn((method: string, ...args: any[]) => ({
      __contractId: id,
      method,
      args,
    })),
  })),
  Address: jest.fn().mockImplementation((pubkey: string) => ({
    toScVal: () => ({ __address: pubkey }),
  })),
  Account: jest.fn().mockImplementation((id: string, seq: string) => ({
    id,
    seq,
  })),
  TransactionBuilder: jest.fn().mockImplementation(() => ({
    addOperation: jest.fn().mockReturnThis(),
    setTimeout: jest.fn().mockReturnThis(),
    build: jest.fn().mockReturnValue({ toXDR: () => "UNSIGNED_XDR" }),
  })),
  nativeToScVal: jest.fn((val: any) => val),
  scValToNative: jest.fn((val: any) => val),
  rpc: {
    Api: { isSimulationSuccess: jest.fn() },
    assembleTransaction: jest.fn(),
  },
}));

import { rpc, Contract } from "@stellar/stellar-sdk";
import {
  getMonthlySubscription,
  getDueMonthlySubscriptionsForDonor,
  createMonthlySubscription,
  cancelMonthlySubscription,
  MIN_SUBSCRIPTION_INTERVAL_LEDGERS,
} from "@/lib/monthlyGiving";

const DONOR = "GDONORAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const OTHER_DONOR = "GOTHERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const PROJECT_ID = "proj-001";

function rawSubscription(overrides: Record<string, unknown> = {}) {
  return {
    donor: DONOR,
    project_id: PROJECT_ID,
    amount: 250_000_000n,
    interval_ledgers: MIN_SUBSCRIPTION_INTERVAL_LEDGERS,
    next_execution: 100,
    active: true,
    created_at: 50,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("getMonthlySubscription", () => {
  it("returns the decoded subscription on success", async () => {
    (rpc.Api.isSimulationSuccess as jest.Mock).mockReturnValue(true);
    mockSimulateTransaction.mockResolvedValue({
      result: { retval: rawSubscription() },
    });

    const sub = await getMonthlySubscription(DONOR, PROJECT_ID);

    expect(sub).not.toBeNull();
    expect(sub?.donor).toBe(DONOR);
    expect(sub?.projectId).toBe(PROJECT_ID);
    expect(sub?.amountXLM).toBe("25.0000000");
    expect(sub?.active).toBe(true);
  });

  it("returns null when the subscription doesn't exist", async () => {
    (rpc.Api.isSimulationSuccess as jest.Mock).mockReturnValue(false);
    mockSimulateTransaction.mockResolvedValue({
      error: "HostError: Subscription not found",
    });

    const sub = await getMonthlySubscription(DONOR, PROJECT_ID);
    expect(sub).toBeNull();
  });
});

describe("getDueMonthlySubscriptionsForDonor", () => {
  it("returns only this donor's active, due subscriptions", async () => {
    (rpc.Api.isSimulationSuccess as jest.Mock).mockReturnValue(true);
    mockGetLatestLedger.mockResolvedValue({ sequence: 150 });
    mockSimulateTransaction
      // get_subscription_count -> 3
      .mockResolvedValueOnce({ result: { retval: 3 } })
      // index 0: this donor, due
      .mockResolvedValueOnce({
        result: { retval: rawSubscription({ next_execution: 100 }) },
      })
      // index 1: a different donor entirely
      .mockResolvedValueOnce({
        result: { retval: rawSubscription({ donor: OTHER_DONOR }) },
      })
      // index 2: this donor, but not due yet
      .mockResolvedValueOnce({
        result: {
          retval: rawSubscription({
            project_id: "proj-002",
            next_execution: 999,
          }),
        },
      });

    const due = await getDueMonthlySubscriptionsForDonor(DONOR);

    expect(due).toHaveLength(1);
    expect(due[0].projectId).toBe(PROJECT_ID);
  });

  it("skips an index whose read fails and keeps checking the rest", async () => {
    (rpc.Api.isSimulationSuccess as jest.Mock).mockReturnValue(true);
    mockGetLatestLedger.mockResolvedValue({ sequence: 150 });
    mockSimulateTransaction
      .mockResolvedValueOnce({ result: { retval: 2 } })
      .mockRejectedValueOnce(new Error("rpc timeout"))
      .mockResolvedValueOnce({ result: { retval: rawSubscription() } });

    const due = await getDueMonthlySubscriptionsForDonor(DONOR);
    expect(due).toHaveLength(1);
  });
});

describe("createMonthlySubscription", () => {
  it("signs, submits, and returns the created subscription", async () => {
    mockLoadAccount.mockResolvedValue({ accountId: () => DONOR });
    (rpc.Api.isSimulationSuccess as jest.Mock).mockReturnValue(true);
    (rpc.assembleTransaction as jest.Mock).mockReturnValue({
      build: () => ({ toXDR: () => "PREPARED_XDR" }),
    });
    mockSimulateTransaction
      .mockResolvedValueOnce({ result: { retval: null } }) // create_subscription simulate
      .mockResolvedValueOnce({ result: { retval: rawSubscription() } }); // refetch
    mockSignTransactionWithWallet.mockResolvedValue({
      signedXDR: "SIGNED_XDR",
      error: null,
    });
    mockSubmitSorobanTransaction.mockResolvedValue({
      hash: "abc",
      ledger: 100,
    });

    const result = await createMonthlySubscription({
      donor: DONOR,
      projectId: PROJECT_ID,
      amountXLM: "25",
    });

    expect(mockSignTransactionWithWallet).toHaveBeenCalledWith(
      "PREPARED_XDR",
    );
    expect(mockSubmitSorobanTransaction).toHaveBeenCalledWith("SIGNED_XDR");
    expect(result.error).toBeNull();
    expect(result.subscription?.projectId).toBe(PROJECT_ID);
  });

  it("returns a friendly error and never submits when the wallet rejects signing", async () => {
    mockLoadAccount.mockResolvedValue({ accountId: () => DONOR });
    (rpc.Api.isSimulationSuccess as jest.Mock).mockReturnValue(true);
    (rpc.assembleTransaction as jest.Mock).mockReturnValue({
      build: () => ({ toXDR: () => "PREPARED_XDR" }),
    });
    mockSimulateTransaction.mockResolvedValueOnce({
      result: { retval: null },
    });
    mockSignTransactionWithWallet.mockResolvedValue({
      signedXDR: null,
      error: "Transaction rejected.",
    });

    const result = await createMonthlySubscription({
      donor: DONOR,
      projectId: PROJECT_ID,
      amountXLM: "25",
    });

    expect(mockSubmitSorobanTransaction).not.toHaveBeenCalled();
    expect(result.subscription).toBeNull();
    expect(result.error).toBe("Transaction rejected.");
  });

  it("maps a duplicate-subscription simulation failure to friendly text", async () => {
    mockLoadAccount.mockResolvedValue({ accountId: () => DONOR });
    (rpc.Api.isSimulationSuccess as jest.Mock).mockReturnValue(false);
    mockSimulateTransaction.mockResolvedValueOnce({
      error: "HostError: Subscription already exists",
    });

    const result = await createMonthlySubscription({
      donor: DONOR,
      projectId: PROJECT_ID,
      amountXLM: "25",
    });

    expect(result.subscription).toBeNull();
    expect(result.error).toMatch(/already have an active subscription/i);
  });

  it("defaults intervalLedgers to MIN_SUBSCRIPTION_INTERVAL_LEDGERS when omitted", async () => {
    mockLoadAccount.mockResolvedValue({ accountId: () => DONOR });
    (rpc.Api.isSimulationSuccess as jest.Mock).mockReturnValue(true);
    (rpc.assembleTransaction as jest.Mock).mockReturnValue({
      build: () => ({ toXDR: () => "PREPARED_XDR" }),
    });
    mockSimulateTransaction
      .mockResolvedValueOnce({ result: { retval: null } })
      .mockResolvedValueOnce({ result: { retval: rawSubscription() } });
    mockSignTransactionWithWallet.mockResolvedValue({
      signedXDR: "SIGNED_XDR",
      error: null,
    });
    mockSubmitSorobanTransaction.mockResolvedValue({
      hash: "abc",
      ledger: 100,
    });

    await createMonthlySubscription({
      donor: DONOR,
      projectId: PROJECT_ID,
      amountXLM: "25",
    });

    const contractInstance = (Contract as jest.Mock).mock.results[0].value;
    const callArgs = contractInstance.call.mock.calls[0];
    // ["create_subscription", donorScVal, projectIdScVal, amountScVal, intervalScVal]
    expect(callArgs[0]).toBe("create_subscription");
    expect(callArgs[4]).toBe(MIN_SUBSCRIPTION_INTERVAL_LEDGERS);
  });
});

describe("cancelMonthlySubscription", () => {
  it("signs and submits the cancel transaction", async () => {
    mockLoadAccount.mockResolvedValue({ accountId: () => DONOR });
    (rpc.Api.isSimulationSuccess as jest.Mock).mockReturnValue(true);
    (rpc.assembleTransaction as jest.Mock).mockReturnValue({
      build: () => ({ toXDR: () => "PREPARED_XDR" }),
    });
    mockSimulateTransaction.mockResolvedValueOnce({
      result: { retval: null },
    });
    mockSignTransactionWithWallet.mockResolvedValue({
      signedXDR: "SIGNED_XDR",
      error: null,
    });
    mockSubmitSorobanTransaction.mockResolvedValue({
      hash: "abc",
      ledger: 100,
    });

    const result = await cancelMonthlySubscription(DONOR, PROJECT_ID);

    expect(mockSubmitSorobanTransaction).toHaveBeenCalledWith("SIGNED_XDR");
    expect(result.success).toBe(true);
    expect(result.error).toBeNull();
  });

  it("maps a not-found simulation failure to friendly text", async () => {
    mockLoadAccount.mockResolvedValue({ accountId: () => DONOR });
    (rpc.Api.isSimulationSuccess as jest.Mock).mockReturnValue(false);
    mockSimulateTransaction.mockResolvedValueOnce({
      error: "HostError: Subscription not found",
    });

    const result = await cancelMonthlySubscription(DONOR, PROJECT_ID);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no subscription was found/i);
  });

  it("never submits when the wallet rejects signing", async () => {
    mockLoadAccount.mockResolvedValue({ accountId: () => DONOR });
    (rpc.Api.isSimulationSuccess as jest.Mock).mockReturnValue(true);
    (rpc.assembleTransaction as jest.Mock).mockReturnValue({
      build: () => ({ toXDR: () => "PREPARED_XDR" }),
    });
    mockSimulateTransaction.mockResolvedValueOnce({
      result: { retval: null },
    });
    mockSignTransactionWithWallet.mockResolvedValue({
      signedXDR: null,
      error: "Transaction rejected.",
    });

    const result = await cancelMonthlySubscription(DONOR, PROJECT_ID);

    expect(mockSubmitSorobanTransaction).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });
});
