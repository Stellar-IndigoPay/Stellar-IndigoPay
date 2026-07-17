const { buildExtendAllTtlTransaction, runGuardian, start, stop } = require("./guardian");
const { submitTransaction } = require("./stellar");
const { Keypair } = require("@stellar/stellar-sdk");
const logger = require("../logger");

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

    it("should throw if ORACLE_ADMIN_SECRET is missing", async () => {
      delete process.env.ORACLE_ADMIN_SECRET;
      await expect(buildExtendAllTtlTransaction()).rejects.toThrow("ORACLE_ADMIN_SECRET not configured");
    });

    it("should return a base64 XDR string on success", async () => {
      const txXdr = await buildExtendAllTtlTransaction();
      expect(typeof txXdr).toBe("string");
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
