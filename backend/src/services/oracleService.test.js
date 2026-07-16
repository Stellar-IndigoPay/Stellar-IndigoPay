const oracleService = require("./oracleService");
const { server: stellarServer, submitTransaction } = require("./stellar");
const { Keypair, StrKey, Account } = require("@stellar/stellar-sdk");

jest.mock("./stellar", () => {
  const mockServer = {
    orderbook: jest.fn().mockReturnThis(),
    call: jest.fn(),
    loadAccount: jest.fn(),
  };
  return {
    server: mockServer,
    NETWORK_PASSPHRASE: "Test Network",
    submitTransaction: jest.fn(),
  };
});

describe("oracleService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    oracleService.resetCachedPrice();
    global.fetch = jest.fn();
    const adminKeypair = Keypair.random();
    process.env.ORACLE_CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32));
    process.env.ORACLE_ADMIN_SECRET = adminKeypair.secret();
    stellarServer.loadAccount.mockResolvedValue(
      new Account(adminKeypair.publicKey(), "1")
    );
  });

  afterEach(() => {
    oracleService.stop();
  });

  describe("fetchDEXPrice", () => {
    test("successfully calculates mid-market price", async () => {
      stellarServer.call.mockResolvedValue({
        bids: [{ price: "0.12" }],
        asks: [{ price: "0.13" }],
      });

      const price = await oracleService.fetchDEXPrice();
      expect(price).toBe(0.125);
    });

    test("returns null if bids or asks are missing", async () => {
      stellarServer.call.mockResolvedValue({
        bids: [],
        asks: [{ price: "0.13" }],
      });

      const price = await oracleService.fetchDEXPrice();
      expect(price).toBeNull();
    });

    test("returns null on orderbook call error", async () => {
      stellarServer.call.mockRejectedValue(new Error("DEX Error"));

      const price = await oracleService.fetchDEXPrice();
      expect(price).toBeNull();
    });
  });

  describe("fetchCoinGeckoPrice", () => {
    test("successfully fetches XLM price in USD", async () => {
      global.fetch.mockResolvedValue({
        json: jest.fn().mockResolvedValue({
          stellar: { usd: 0.12 }
        })
      });

      const price = await oracleService.fetchCoinGeckoPrice();
      expect(price).toBe(0.12);
    });

    test("returns null on fetch error", async () => {
      global.fetch.mockRejectedValue(new Error("Network Error"));

      const price = await oracleService.fetchCoinGeckoPrice();
      expect(price).toBeNull();
    });
  });

  describe("updateOracle", () => {
    test("updates when no cached price exists", async () => {
      stellarServer.call.mockResolvedValue({
        bids: [{ price: "0.12" }],
        asks: [{ price: "0.12" }],
      });
      submitTransaction.mockResolvedValue({ status: "SUCCESS" });

      await oracleService.updateOracle();

      expect(oracleService.getCurrentPrice()).toBe(0.12);
      expect(submitTransaction).toHaveBeenCalled();
    });

    test("falls back to CoinGecko when DEX price is unavailable", async () => {
      stellarServer.call.mockResolvedValue({
        bids: [],
        asks: [],
      });
      global.fetch.mockResolvedValue({
        json: jest.fn().mockResolvedValue({
          stellar: { usd: 0.10 }
        })
      });
      submitTransaction.mockResolvedValue({ status: "SUCCESS" });

      await oracleService.updateOracle();

      expect(oracleService.getCurrentPrice()).toBe(0.10);
      expect(submitTransaction).toHaveBeenCalled();
    });

    test("does not update on-chain if price change is below threshold (2%)", async () => {
      // 1. Initial update
      stellarServer.call.mockResolvedValue({
        bids: [{ price: "0.10" }],
        asks: [{ price: "0.10" }],
      });
      submitTransaction.mockResolvedValue({ status: "SUCCESS" });
      await oracleService.updateOracle();
      expect(submitTransaction).toHaveBeenCalledTimes(1);

      // 2. Small change (1% change: 0.10 -> 0.101)
      stellarServer.call.mockResolvedValue({
        bids: [{ price: "0.101" }],
        asks: [{ price: "0.101" }],
      });
      submitTransaction.mockClear();
      await oracleService.updateOracle();

      expect(submitTransaction).not.toHaveBeenCalled();
      expect(oracleService.getCurrentPrice()).toBe(0.101); // Local cache still updates to fresh price
    });

    test("updates on-chain if price change is above threshold (2%)", async () => {
      // 1. Initial update
      stellarServer.call.mockResolvedValue({
        bids: [{ price: "0.10" }],
        asks: [{ price: "0.10" }],
      });
      submitTransaction.mockResolvedValue({ status: "SUCCESS" });
      await oracleService.updateOracle();

      // 2. Significant change (5% change: 0.10 -> 0.105)
      stellarServer.call.mockResolvedValue({
        bids: [{ price: "0.105" }],
        asks: [{ price: "0.105" }],
      });
      submitTransaction.mockClear();
      await oracleService.updateOracle();

      expect(submitTransaction).toHaveBeenCalledTimes(1);
      expect(oracleService.getCurrentPrice()).toBe(0.105);
    });

    test("throws error if all price sources fail", async () => {
      stellarServer.call.mockRejectedValue(new Error("DEX fail"));
      global.fetch.mockRejectedValue(new Error("CG fail"));

      await expect(oracleService.updateOracle()).rejects.toThrow("All price sources failed");
    });
  });
});
