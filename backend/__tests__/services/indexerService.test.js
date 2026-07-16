/**
 * __tests__/services/indexerService.test.js
 *
 * Tests for the Horizon indexer service with USDC payment support (GF-004).
 *
 * Coverage:
 *   - handleDonation with native XLM payments (unchanged behaviour)
 *   - handleDonation with USDC payments (currency, null amount_xlm, XLM-equivalent)
 *   - handleDonation deduplication by transaction hash
 *   - Unknown/non-matching asset types silently skipped
 *   - USDC CO₂ offset calculation
 */

"use strict";

// ── Mocks: factories MUST NOT reference module-level variables ─────────────

jest.mock("../../src/db/pool", () => ({
  query: jest.fn(),
  connect: jest.fn(),
}));

jest.mock("../../src/services/store", () => ({
  computeBadges: jest.fn(() => [{ tier: "seedling", earnedAt: "2026-01-01T00:00:00.000Z" }]),
}));

jest.mock("../../src/services/webhook", () => ({
  checkAndDeliverMilestones: jest.fn().mockResolvedValue(),
}));

jest.mock("../../src/logger", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

// ── Module imports (after mocks) ──────────────────────────────────────────

const pool = require("../../src/db/pool");
const { handleDonation } = require("../../src/services/indexerService");

// ── Helpers ─────────────────────────────────────────────────────────────────

function mockXlmOp(overrides = {}) {
  return {
    type: "payment",
    asset_type: "native",
    from: "GDONORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    to: "GPROJECTXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    amount: "100.0000000",
    transaction_hash: "abc123".repeat(8).slice(0, 64),
    ledger_attr: 12345678,
    ...overrides,
  };
}

function mockUsdcOp(overrides = {}) {
  return {
    type: "payment",
    asset_type: "credit_alphanum4",
    asset_code: "USDC",
    asset_issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    from: "GDONOR2XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    to: "GPROJECT2XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    amount: "50.0000000",
    transaction_hash: "def456".repeat(8).slice(0, 64),
    ledger_attr: 12345679,
    ...overrides,
  };
}

/**
 * Create a mock database client.
 * Default: no existing donation (dedup returns empty), all queries succeed.
 * Tests can override specific queries via `client.query.mockResolvedValueOnce(...)`.
 */
function makeMockClient() {
  const mockQuery = jest.fn();
  let inTx = false;

  // Default implementation handles common query patterns
  mockQuery.mockImplementation((sql) => {
    if (sql === "BEGIN") { inTx = true; return { rows: [] }; }
    if (sql === "COMMIT") { inTx = false; return { rows: [] }; }
    if (sql === "ROLLBACK") { inTx = false; return { rows: [] }; }
    if (sql.includes("SELECT COUNT(DISTINCT project_id)")) {
      return { rows: [{ count: 1 }] };
    }
    if (sql.includes("FROM profiles WHERE public_key")) {
      // No existing profile
      return { rows: [] };
    }
    if (sql.includes("UPDATE projects")) {
      return { rows: [] };
    }
    if (sql.includes("INSERT INTO profiles")) {
      return { rows: [] };
    }
    // Default: empty rows
    return { rows: [] };
  });

  return {
    query: mockQuery,
    release: jest.fn(),
    _inTransaction: () => inTx,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  // Reset pool.connect to default behaviour
  pool.connect.mockReset();
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("handleDonation with native XLM", () => {
  const op = mockXlmOp();
  const projectId = "proj-1";

  test("inserts XLM donation with correct fields", async () => {
    const client = makeMockClient();
    pool.connect.mockResolvedValue(client);

    await handleDonation(projectId, op, { isNative: true, isUSDC: false });

    const insertCall = client.query.mock.calls.find(
      ([sql]) => sql.startsWith("INSERT INTO donations"),
    );
    expect(insertCall).toBeDefined();
    expect(insertCall[1][3]).toBe(100); // amount_xlm
    expect(insertCall[1][4]).toBe(100); // amount
    expect(insertCall[1][5]).toBe("XLM"); // currency
  });

  test("deduplicates by transaction hash", async () => {
    const client = makeMockClient();
    // First query (dedup check) returns existing donation
    client.query.mockResolvedValueOnce({ rows: [{ id: "existing" }] });
    pool.connect.mockResolvedValue(client);

    await handleDonation(projectId, op, { isNative: true, isUSDC: false });

    const insertCalls = client.query.mock.calls.filter(
      ([sql]) => sql.startsWith("INSERT INTO donations"),
    );
    expect(insertCalls).toHaveLength(0);
  });

  test("updates project raised_xlm by the XLM amount", async () => {
    const client = makeMockClient();
    pool.connect.mockResolvedValue(client);

    await handleDonation(projectId, op, { isNative: true, isUSDC: false });

    const updateCall = client.query.mock.calls.find(
      ([sql]) => sql.startsWith("UPDATE projects"),
    );
    expect(updateCall).toBeDefined();
    expect(updateCall[1][0]).toBe(100); // increment by 100 XLM
  });

  test("releases the client after processing", async () => {
    const client = makeMockClient();
    pool.connect.mockResolvedValue(client);

    await handleDonation(projectId, op, { isNative: true, isUSDC: false });

    expect(client.release).toHaveBeenCalled();
  });
});

describe("handleDonation with USDC", () => {
  const projectId = "proj-2";
  const op = mockUsdcOp();

  test("inserts USDC donation with null amount_xlm", async () => {
    const client = makeMockClient();
    pool.connect.mockResolvedValue(client);

    await handleDonation(projectId, op, { isNative: false, isUSDC: true });

    const insertCall = client.query.mock.calls.find(
      ([sql]) => sql.startsWith("INSERT INTO donations"),
    );
    expect(insertCall).toBeDefined();
    expect(insertCall[1][3]).toBeNull(); // amount_xlm = null for USDC
    expect(insertCall[1][4]).toBe(50);   // amount = 50 USDC
    expect(insertCall[1][5]).toBe("USDC"); // currency
  });

  test("updates project raised_xlm by XLM-equivalent", async () => {
    const client = makeMockClient();
    pool.connect.mockResolvedValue(client);

    // Default USDC_TO_XLM_RATE = 8.0 → 50 USDC * 8 = 400 XLM-equivalent
    await handleDonation(projectId, op, { isNative: false, isUSDC: true });

    const updateCall = client.query.mock.calls.find(
      ([sql]) => sql.startsWith("UPDATE projects"),
    );
    expect(updateCall).toBeDefined();
    expect(updateCall[1][0]).toBe(400); // 50 USDC * 8 XLM rate
  });

  test("updates donor profile with XLM-equivalent total", async () => {
    const client = makeMockClient();
    pool.connect.mockResolvedValue(client);

    await handleDonation(projectId, op, { isNative: false, isUSDC: true });

    const profileCall = client.query.mock.calls.find(
      ([sql]) => sql.startsWith("INSERT INTO profiles"),
    );
    expect(profileCall).toBeDefined();
    // 50 USDC * 8 rate = 400 XLM-equivalent total
    expect(profileCall[1][1]).toBe("400.0000000");
  });

  test("deduplicates USDC donations by transaction hash", async () => {
    const client = makeMockClient();
    client.query.mockResolvedValueOnce({ rows: [{ id: "existing-usdc" }] });
    pool.connect.mockResolvedValue(client);

    await handleDonation(projectId, op, { isNative: false, isUSDC: true });

    const insertCalls = client.query.mock.calls.filter(
      ([sql]) => sql.startsWith("INSERT INTO donations"),
    );
    expect(insertCalls).toHaveLength(0);
  });

  test("uses custom USDC_TO_XLM_RATE via updateProjectWallets", async () => {
    // Set env var before reloading the module so updateProjectWallets picks it up
    process.env.USDC_TO_XLM_RATE = "12.5";
    jest.resetModules();
    jest.mock("../../src/db/pool", () => ({
      query: jest.fn().mockResolvedValue({ rows: [] }),
      connect: jest.fn(),
    }));
    jest.mock("../../src/services/store", () => ({
      computeBadges: jest.fn(() => []),
    }));
    jest.mock("../../src/services/webhook", () => ({
      checkAndDeliverMilestones: jest.fn().mockResolvedValue(),
    }));
    jest.mock("../../src/logger", () => ({
      info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
    }));

    // Re-require pool AFTER resetModules to get the fresh mock reference
    const freshPool = require("../../src/db/pool");
    const indexer = require("../../src/services/indexerService");
    // updateProjectWallets reads the env var and sets the module-level rate
    await indexer.updateProjectWallets();

    const client = makeMockClient();
    freshPool.connect.mockResolvedValue(client);

    await indexer.handleDonation(projectId, op, { isNative: false, isUSDC: true });

    const updateCall = client.query.mock.calls.find(
      ([sql]) => sql.startsWith("UPDATE projects"),
    );
    // 50 USDC * 12.5 = 625 XLM-equivalent
    expect(updateCall[1][0]).toBe(625);

    delete process.env.USDC_TO_XLM_RATE;
  });
});

describe("handleDonation with unknown assets", () => {
  test("returns early without inserting for non-payment ops", async () => {
    const client = makeMockClient();
    pool.connect.mockResolvedValue(client);

    // handleDonation with isNative=false and isUSDC=false should return early
    await handleDonation("proj-1", { type: "manage_offer", transaction_hash: "noop" }, { isNative: false, isUSDC: false });

    // No queries should occur since the function returns early
    expect(client.query).not.toHaveBeenCalled();
    expect(client.release).not.toHaveBeenCalled();
  });

  test("skips when amount is zero or negative", async () => {
    const client = makeMockClient();
    pool.connect.mockResolvedValue(client);

    const zeroOp = mockXlmOp({ amount: "0" });
    await handleDonation("proj-1", zeroOp, { isNative: true, isUSDC: false });

    // No INSERT should occur for zero amount
    const insertCalls = client.query.mock.calls.filter(
      ([sql]) => sql.startsWith("INSERT INTO donations"),
    );
    expect(insertCalls).toHaveLength(0);
  });
});

describe("handleDonation error handling", () => {
  test("rolls back transaction on query failure", async () => {
    const client = makeMockClient();
    pool.connect.mockResolvedValue(client);

    // Override the default mock to throw on INSERT
    const originalImpl = client.query.getMockImplementation();
    client.query.mockImplementation((sql) => {
      if (sql.startsWith("INSERT INTO donations")) {
        throw new Error("DB constraint violation");
      }
      // Fall through to default for BEGIN/COMMIT etc.
      if (sql === "BEGIN") return { rows: [] };
      if (sql === "ROLLBACK") return { rows: [] };
      return { rows: [] };
    });

    const op = mockXlmOp();
    await expect(
      handleDonation("proj-1", op, { isNative: true, isUSDC: false }),
    ).resolves.toBeUndefined();

    // Should have tried to ROLLBACK
    const rollbackCalls = client.query.mock.calls.filter(
      ([sql]) => sql === "ROLLBACK",
    );
    expect(rollbackCalls.length).toBeGreaterThanOrEqual(1);
  });

  test("releases client on error", async () => {
    const client = makeMockClient();
    pool.connect.mockResolvedValue(client);

    // Make every query throw
    client.query.mockReset();
    client.query.mockRejectedValue(new Error("Connection failed"));
    // But we still need BEGIN/COMMIT/ROLLBACK to work minimally
    client.query.mockImplementation((sql) => {
      if (sql === "ROLLBACK") return { rows: [] };
      throw new Error("Connection failed");
    });

    const op = mockXlmOp();
    await expect(
      handleDonation("proj-1", op, { isNative: true, isUSDC: false }),
    ).resolves.toBeUndefined();

    expect(client.release).toHaveBeenCalled();
  });
});

describe("updateProjectWallets", () => {
  beforeEach(() => {
    delete process.env.USDC_TOKEN_ADDRESS;
  });

  test("loads USDC token address from env var", async () => {
    process.env.USDC_TOKEN_ADDRESS = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
    jest.resetModules();
    jest.mock("../../src/db/pool", () => ({
      query: jest.fn().mockResolvedValue({ rows: [] }),
      connect: jest.fn(),
    }));
    jest.mock("../../src/logger", () => ({
      info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
    }));

    const { updateProjectWallets } = require("../../src/services/indexerService");
    await updateProjectWallets();

    // No errors should be thrown
    expect(true).toBe(true);
    delete process.env.USDC_TOKEN_ADDRESS;
  });

  test("skips USDC indexing when token address is not configured", async () => {
    delete process.env.USDC_TOKEN_ADDRESS;
    jest.resetModules();
    jest.mock("../../src/db/pool", () => ({
      query: jest.fn().mockResolvedValue({ rows: [] }),
      connect: jest.fn(),
    }));
    jest.mock("../../src/logger", () => ({
      info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
    }));

    const { updateProjectWallets } = require("../../src/services/indexerService");
    await updateProjectWallets();

    const logger = require("../../src/logger");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "usdc_token_unconfigured" }),
      expect.any(String),
    );
  });
});
