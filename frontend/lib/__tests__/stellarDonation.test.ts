/**
 * lib/__tests__/stellarDonation.test.ts
 *
 * Unit tests for the Workstream 1 / 5 / 6 helpers added to lib/stellar.ts:
 * fee estimation, Max-button math, transaction polling, and the donation
 * simulation used by TransactionPreview.
 */
import { Account, StrKey } from "@stellar/stellar-sdk";
import * as stellar from "@/lib/stellar";

// Real, checksum-valid test keys (the Account constructor validates strkeys).
const DONOR = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 7));
const PROJECT = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 9));

const {
  BASE_FEE_STROOPS,
  BASE_RESERVE_FALLBACK_XLM,
  BASE_RESERVE_XLM,
  STROOPS_PER_XLM,
  estimateFeeStroops,
  stroopsToXLM,
  calculateMaxDonation,
  calculateMinimumReserveXLM,
  formatFeeXLM,
  pollTransaction,
  simulateDonation,
  shortenAddressForPreview,
  formatTransactionError,
  getAccountSummary,
  getBaseReserveXLM,
  resetBaseReserveCache,
} = stellar;

describe("estimateFeeStroops (Workstream 1)", () => {
  it("charges the 100-stroop base fee per operation", () => {
    expect(BASE_FEE_STROOPS).toBe(100);
    expect(estimateFeeStroops(1)).toBe(100);
    expect(estimateFeeStroops(2)).toBe(200);
  });

  it("never returns less than one base fee", () => {
    expect(estimateFeeStroops(0)).toBe(100);
    expect(estimateFeeStroops(-3)).toBe(100);
  });
});

describe("stroopsToXLM / formatFeeXLM", () => {
  it("converts stroops to an XLM decimal string", () => {
    expect(stroopsToXLM(100)).toBe("0.0000100");
    expect(stroopsToXLM(STROOPS_PER_XLM)).toBe("1.0000000");
  });

  it("formats a human-readable fee", () => {
    expect(formatFeeXLM(100)).toBe("0.0000100 XLM");
  });
});

describe("calculateMaxDonation (Workstream 1)", () => {
  it("computes max = balance − reserve − fee − 1 stroop margin", () => {
    // 100 − 2 − 0.0000100 − 0.0000001 = 97.9999899
    expect(calculateMaxDonation("100")).toBe("97.9999899");
  });

  it("returns zero when the balance cannot cover reserve + fee", () => {
    expect(calculateMaxDonation("1")).toBe("0");
    expect(calculateMaxDonation("0")).toBe("0");
    expect(calculateMaxDonation("abc")).toBe("0");
  });

  it("accepts custom reserve and fee", () => {
    // 95 − 2 − 0.00001 − 0.0000001 = 92.9999899
    expect(
      calculateMaxDonation("95", BASE_RESERVE_XLM, estimateFeeStroops(1)),
    ).toBe("92.9999899");
  });

  it("leaves a dust margin so the tx never fails for rounding", () => {
    const max = parseFloat(calculateMaxDonation("100"));
    // max + fee + reserve must be < balance (the 1-stroop margin makes it <)
    expect(max + 0.00001 + BASE_RESERVE_XLM).toBeLessThan(100);
  });
});

describe("pollTransaction (Workstream 6)", () => {
  const HASH = "a".repeat(64);

  function fakeServer(handler: () => Promise<unknown>) {
    return {
      transactions: () => ({
        transaction: () => ({ call: handler }),
      }),
    };
  }

  it("resolves once the transaction appears in a ledger", async () => {
    const handler = jest
      .fn()
      .mockRejectedValueOnce(new Error("404 not found"))
      .mockResolvedValueOnce({ id: HASH, successful: true });

    const record = await pollTransaction(HASH, {
      horizonServer: fakeServer(handler) as never,
      intervalMs: 10,
      timeoutMs: 500,
    });

    expect(record).toEqual({ id: HASH, successful: true });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("rejects with TIMEOUT when the tx never appears", async () => {
    const handler = jest.fn().mockRejectedValue(new Error("404 not found"));

    await expect(
      pollTransaction(HASH, {
        horizonServer: fakeServer(handler) as never,
        intervalMs: 10,
        timeoutMs: 60,
      }),
    ).rejects.toThrow("TIMEOUT");
  });

  it("rejects with TRANSACTION_FAILED when the tx is included but failed on-chain", async () => {
    // Included in a ledger with successful: false — the payment failed, so
    // the caller must never treat this as a confirmed donation (WS6).
    const handler = jest.fn().mockResolvedValue({
      id: HASH,
      successful: false,
    });

    await expect(
      pollTransaction(HASH, {
        horizonServer: fakeServer(handler) as never,
        intervalMs: 10,
        timeoutMs: 500,
      }),
    ).rejects.toThrow("TRANSACTION_FAILED");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("keeps polling past a failed record until the tx is included", async () => {
    // A 404 (not yet included) followed by a successful record.
    const handler = jest
      .fn()
      .mockRejectedValueOnce(new Error("404 not found"))
      .mockResolvedValueOnce({ id: HASH, successful: true });

    const record = await pollTransaction(HASH, {
      horizonServer: fakeServer(handler) as never,
      intervalMs: 10,
      timeoutMs: 500,
    });

    expect(record).toEqual({ id: HASH, successful: true });
  });
});

describe("getAccountSummary / getBaseReserveXLM (Workstream 1 dynamic reserve)", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    resetBaseReserveCache();
  });

  it("returns the balance plus subentry and sponsorship counts from one account load", async () => {
    jest.spyOn(stellar.server, "loadAccount").mockResolvedValue({
      balances: [{ asset_type: "native", balance: "100.5000000" }],
      num_subentries: 2,
      num_sponsoring: 1,
      num_sponsored: 0,
    } as never);

    const summary = await getAccountSummary(DONOR);
    expect(summary.balance).toBe("100.5000000");
    expect(summary.subentries).toBe(2);
    expect(summary.numSponsoring).toBe(1);
    expect(summary.numSponsored).toBe(0);
  });

  it("defaults missing sponsorship counts to zero", async () => {
    jest.spyOn(stellar.server, "loadAccount").mockResolvedValue({
      balances: [{ asset_type: "native", balance: "10" }],
    } as never);

    const summary = await getAccountSummary(DONOR);
    expect(summary.subentries).toBe(0);
    expect(summary.numSponsoring).toBe(0);
    expect(summary.numSponsored).toBe(0);
  });

  it("derives the true minimum reserve from the live base reserve and sponsorship counts", () => {
    // base_reserve × (2 + subentries + sponsoring): a plain account owes
    // 2 × 0.5 = 1 XLM; one with 2 subentries + 1 sponsored entry owes
    // (2 + 2 + 1) × 0.5 = 2.5 XLM.
    expect(calculateMinimumReserveXLM(0, 0, 0.5)).toBe(1);
    expect(calculateMinimumReserveXLM(2, 1, 0.5)).toBe(2.5);
    expect(calculateMinimumReserveXLM(0, 0, 2)).toBe(4);
  });

  it("reads the live base reserve from Horizon", async () => {
    // Testnet's current base reserve is 0.5 XLM (5,000,000 stroops).
    jest.spyOn(stellar.server, "ledgers").mockReturnValue({
      order: () => ({
        limit: () => ({
          call: jest.fn().mockResolvedValue({
            records: [{ base_reserve_in_stroops: "5000000" }],
          }),
        }),
      }),
    } as never);
    await expect(getBaseReserveXLM()).resolves.toBe(0.5);
  });

  it("falls back to the protocol base reserve when Horizon is unreachable", async () => {
    jest.spyOn(stellar.server, "ledgers").mockReturnValue({
      order: () => ({
        limit: () => ({
          call: jest.fn().mockRejectedValue(new Error("boom")),
        }),
      }),
    } as never);
    // The offline fallback is the protocol base reserve (0.5 XLM), which is
    // distinct from the 2 XLM MINIMUM_BALANCE_XLM used by calculateMaxDonation.
    await expect(getBaseReserveXLM()).resolves.toBe(BASE_RESERVE_FALLBACK_XLM);
  });
});

describe("simulateDonation (Workstream 5)", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest
      .spyOn(stellar.server, "loadAccount")
      // The real Account class is not typed as an AccountResponse, but it is
      // exactly what the transaction builder consumes at runtime.
      .mockResolvedValue(new Account(DONOR, "123456") as never);
  });

  it("returns the destination, amount, fee, and total debited", async () => {
    const result = await simulateDonation({
      fromPublicKey: DONOR,
      toPublicKey: PROJECT,
      amount: "10",
      currency: "XLM",
      memo: "IndigoPay:test",
    });

    expect(result.destination).toBe(PROJECT);
    expect(result.amount).toBe("10");
    expect(result.currency).toBe("XLM");
    expect(result.feeStroops).toBe(100);
    expect(result.feeXLM).toBe("0.0000100");
    expect(result.totalDebited).toBe("10.0000100");
    // The SDK increments the source sequence when building (123456 → 123457)
    // and may surface it as a string or number.
    expect(String(result.sequence)).toBe("123457");
  });

  it("does not add a fee to USDC totals (fee is paid in XLM separately)", async () => {
    const result = await simulateDonation({
      fromPublicKey: DONOR,
      toPublicKey: PROJECT,
      amount: "25",
      currency: "USDC",
    });

    expect(result.currency).toBe("USDC");
    expect(result.totalDebited).toBeNull();
  });

  it("builds the skeleton tx via the same path the donor will sign", async () => {
    await simulateDonation({
      fromPublicKey: DONOR,
      toPublicKey: PROJECT,
      amount: "5",
      currency: "XLM",
    });
    expect(stellar.server.loadAccount).toHaveBeenCalledWith(DONOR);
  });
});

describe("formatTransactionError (Workstream 6 friendly errors)", () => {
  it("explains tx_too_late so a stale signature is never a raw error code", () => {
    const err = {
      response: {
        data: {
          extras: {
            result_codes: { transaction: "tx_too_late" },
          },
        },
      },
    };
    expect(formatTransactionError(err)).toBe(
      "The transaction expired while it was being signed. Nothing was sent — please try again.",
    );
  });

  it("still explains underfunded payments", () => {
    const err = {
      response: {
        data: {
          extras: {
            result_codes: { transaction: "tx_failed", operations: ["op_underfunded"] },
          },
        },
      },
    };
    expect(formatTransactionError(err)).toBe(
      "Insufficient XLM balance for network fees or the payment.",
    );
  });
});

describe("shortenAddressForPreview", () => {
  it("truncates a long public key to GABC…XYZ", () => {
    const full = `G${"A".repeat(54)}XYZ`;
    expect(shortenAddressForPreview(full)).toBe(`G${"A".repeat(3)}…XYZ`);
  });

  it("returns short strings unchanged", () => {
    expect(shortenAddressForPreview("GABC")).toBe("GABC");
    expect(shortenAddressForPreview("")).toBe("");
  });
});
