const { buildExtendAllTtlTransaction, runGuardian, runGuardianCycle, start, stop } = require("./guardian");
const { submitTransaction } = require("./stellar");
const { Keypair } = require("@stellar/stellar-sdk");
const logger = require("../logger");

// The real advisory lock helper talks to Postgres; pass the guarded work
// straight through so `runGuardian` stays under test, and assert the lock is
// requested with the right key separately.
jest.mock("./advisoryLock", () => ({
  LOCK_KEYS: { guardian: "worker:guardian" },
  withAdvisoryLock: jest.fn(async (_lockName, fn) => fn()),
}));

const { withAdvisoryLock, LOCK_KEYS } = require("./advisoryLock");

jest.mock("./stellar", () => ({
  submitTransaction: jest.fn(),
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  server: {
    loadAccount: jest.fn().mockImplementation(async (pubkey) => {
      const { Account } = require("@stellar/stellar-sdk");
      return new Account(pubkey, "12345");
    }),
  },
}));

jest.mock("../logger", () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

describe("Guardian Service", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.NODE_ENV = "test";
    process.env.CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
    // Dummy secret key
    process.env.ORACLE_ADMIN_SECRET = Keypair.random().secret();
  });

  afterEach(() => {
    process.env = originalEnv;
    stop();
  });

  describe("buildExtendAllTtlTransaction", () => {
    it("should throw if CONTRACT_ID is missing", async () => {
      delete process.env.CONTRACT_ID;
      await expect(buildExtendAllTtlTransaction()).rejects.toThrow("CONTRACT_ID not configured");
    });

    it("should throw if managed oracle admin secret is missing", async () => {
      delete process.env.ORACLE_ADMIN_SECRET;
      await expect(buildExtendAllTtlTransaction()).rejects.toThrow("oracle admin signer must be loaded from a managed secret file");
    });

    it("should return a base64 XDR string on success", async () => {
      const txXdr = await buildExtendAllTtlTransaction();
      expect(typeof txXdr).toBe("string");
    });
  });

  describe("runGuardianCycle", () => {
    it("acquires the guardian advisory lock around runGuardian", async () => {
      submitTransaction.mockResolvedValue({ status: "SUCCESS" });

      await runGuardianCycle();

      expect(withAdvisoryLock).toHaveBeenCalledWith(
        LOCK_KEYS.guardian,
        runGuardian,
      );
      expect(submitTransaction).toHaveBeenCalled();
    });

    it("returns false without submitting when the lock is not acquired", async () => {
      withAdvisoryLock.mockResolvedValueOnce(false);

      const result = await runGuardianCycle();

      expect(result).toBe(false);
      expect(submitTransaction).not.toHaveBeenCalled();
    });
  });

  describe("runGuardian", () => {
    it("should build and submit a transaction", async () => {
      submitTransaction.mockResolvedValue({ status: "SUCCESS" });
      await runGuardian();
      expect(submitTransaction).toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        { event: "guardian_ttl_extended" },
        "Guardian successfully extended all TTLs"
      );
    });

    it("should log and throw if submitTransaction fails", async () => {
      const err = new Error("Network error");
      submitTransaction.mockRejectedValue(err);
      await expect(runGuardian()).rejects.toThrow("Network error");
      expect(logger.error).toHaveBeenCalledWith(
        { event: "guardian_ttl_extend_failed", err: "Network error" },
        "Guardian failed to extend TTL"
      );
    });
  });
});
