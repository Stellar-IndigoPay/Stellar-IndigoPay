"use strict";

// ── Mocks ──────────────────────────────────────────────────────────────────

jest.mock("../db/pool", () => ({
  connect: jest.fn(),
}));

jest.mock("uuid", () => ({
  v4: jest.fn(() => "mock-uuid-1"),
}));

jest.mock("../logger", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock("pg-boss", () => {
  const mockBoss = {
    start: jest.fn().mockResolvedValue(),
    work: jest.fn().mockResolvedValue(),
    send: jest.fn().mockResolvedValue("job-123"),
    stop: jest.fn().mockResolvedValue(),
    on: jest.fn(),
  };
  return jest.fn(() => mockBoss);
});

// ── Imports ─────────────────────────────────────────────────────────────────

const pool = require("../db/pool");
const { v4: uuid } = require("uuid");
const logger = require("../logger");
const {
  processMatching,
  enqueueDonationMatching,
  QUEUE,
} = require("./matchQueue");

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeMockClient() {
  const mockQuery = jest.fn();
  let inTx = false;

  mockQuery.mockImplementation((sql) => {
    if (sql === "BEGIN") {
      inTx = true;
      return { rows: [] };
    }
    if (sql === "COMMIT") {
      inTx = false;
      return { rows: [] };
    }
    if (sql === "ROLLBACK") {
      inTx = false;
      return { rows: [] };
    }
    return { rows: [] };
  });

  return {
    query: mockQuery,
    release: jest.fn(),
    _inTransaction: () => inTx,
  };
}

function mockActiveOffer(overrides = {}) {
  return {
    id: overrides.id || "offer-1",
    matcher_address: overrides.matcher_address || "GMATCHERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    cap_xlm: overrides.cap_xlm ?? "100",
    matched_xlm: overrides.matched_xlm ?? "0",
    multiplier: overrides.multiplier ?? 2,
  };
}

function makeJobData(overrides = {}) {
  return {
    data: {
      projectId: overrides.projectId || "proj-1",
      parsedAmount: overrides.parsedAmount ?? 50,
      donorAddress: overrides.donorAddress || "GDONORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      transactionHash: overrides.transactionHash || "abc123".repeat(8).slice(0, 64),
    },
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("matchQueue: processMatching", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset UUID counter per test
    let counter = 1;
    uuid.mockImplementation(() => `mock-uuid-${counter++}`);
  });

  test("QUEUE constant is 'donation-matching'", () => {
    expect(QUEUE).toBe("donation-matching");
  });

  // ── No offers ──────────────────────────────────────────────────────────

  test("returns early when no active matching offers exist", async () => {
    const client = makeMockClient();
    client.query.mockImplementation((sql) => {
      if (sql.includes("FROM donation_matches")) {
        return { rows: [] };
      }
      return { rows: [] };
    });
    pool.connect.mockResolvedValue(client);

    const job = makeJobData();
    await processMatching(job);

    // Should not have opened a transaction
    expect(client.query).not.toHaveBeenCalledWith("BEGIN");
    expect(client.query).not.toHaveBeenCalledWith("COMMIT");
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ event: "matching_no_offers" }),
      expect.any(String),
    );
  });

  // ── Single offer, full match ───────────────────────────────────────────

  test("inserts matched donation and updates counter for a single active offer", async () => {
    const client = makeMockClient();
    const matchRow = mockActiveOffer({ id: "offer-1" });
    client.query.mockImplementation((sql) => {
      if (sql.includes("FROM donation_matches")) {
        return { rows: [matchRow] };
      }
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [] };
      }
      return { rows: [] };
    });
    pool.connect.mockResolvedValue(client);

    const job = makeJobData({ parsedAmount: 50 }); // 50 * 2 = 100
    await processMatching(job);

    // Verify BEGIN was called
    expect(client.query).toHaveBeenCalledWith("BEGIN");

    // Verify INSERT INTO donations with correct values
    const insertCall = client.query.mock.calls.find(
      ([sql]) => sql.startsWith("INSERT INTO donations"),
    );
    expect(insertCall).toBeDefined();
    expect(insertCall[1][1]).toBe("proj-1"); // project_id
    expect(insertCall[1][2]).toBe(matchRow.matcher_address); // donor_address = matcher
    expect(insertCall[1][3]).toBe(100); // amount_xlm = 50 * 2
    expect(insertCall[1][4]).toBe(100); // amount
    expect(insertCall[1][5]).toBe("XLM"); // currency
    expect(insertCall[1][6]).toContain("Matching donation");

    // Verify UPDATE donation_matches
    const updateMatchCall = client.query.mock.calls.find(
      ([sql]) => sql.includes("UPDATE donation_matches"),
    );
    expect(updateMatchCall).toBeDefined();
    expect(updateMatchCall[1][0]).toBe(100);
    expect(updateMatchCall[1][1]).toBe("offer-1");

    // Verify UPDATE projects
    const updateProjectCall = client.query.mock.calls.find(
      ([sql]) => sql.includes("UPDATE projects"),
    );
    expect(updateProjectCall).toBeDefined();
    expect(updateProjectCall[1][0]).toBe(100);
    expect(updateProjectCall[1][1]).toBe("proj-1");

    // Verify COMMIT
    expect(client.query).toHaveBeenCalledWith("COMMIT");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  // ── Offer at cap (remaining <= 0) ──────────────────────────────────────

  test("skips an offer whose cap is already reached", async () => {
    const client = makeMockClient();
    const matchRow = mockActiveOffer({
      id: "offer-full",
      cap_xlm: "100",
      matched_xlm: "100", // already fully matched
    });
    client.query.mockImplementation((sql) => {
      if (sql.includes("FROM donation_matches")) {
        return { rows: [matchRow] };
      }
      return { rows: [] };
    });
    pool.connect.mockResolvedValue(client);

    const job = makeJobData({ parsedAmount: 50 });
    await processMatching(job);

    // No transaction should be opened since no matches were applied
    expect(client.query).not.toHaveBeenCalledWith("BEGIN");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  // ── Offer capped by remaining ──────────────────────────────────────────

  test("caps match amount at remaining capacity", async () => {
    const client = makeMockClient();
    const matchRow = mockActiveOffer({
      id: "offer-partial",
      cap_xlm: "100",
      matched_xlm: "70", // only 30 remaining
    });
    client.query.mockImplementation((sql) => {
      if (sql.includes("FROM donation_matches")) {
        return { rows: [matchRow] };
      }
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [] };
      }
      return { rows: [] };
    });
    pool.connect.mockResolvedValue(client);

    const job = makeJobData({ parsedAmount: 50 }); // 50 * 2 = 100, but only 30 remaining
    await processMatching(job);

    const insertCall = client.query.mock.calls.find(
      ([sql]) => sql.startsWith("INSERT INTO donations"),
    );
    // Should be capped at 30, not 100
    expect(insertCall[1][3]).toBe(30);

    const updateMatchCall = client.query.mock.calls.find(
      ([sql]) => sql.includes("UPDATE donation_matches"),
    );
    expect(updateMatchCall[1][0]).toBe(30);
  });

  // ── Multiple offers ────────────────────────────────────────────────────

  test("processes multiple active offers, summing matched XLM", async () => {
    const client = makeMockClient();
    const offers = [
      mockActiveOffer({ id: "offer-1", cap_xlm: "100", matched_xlm: "0", multiplier: 2 }),
      mockActiveOffer({ id: "offer-2", cap_xlm: "200", matched_xlm: "0", multiplier: 1 }),
    ];
    client.query.mockImplementation((sql) => {
      if (sql.includes("FROM donation_matches")) {
        return { rows: offers };
      }
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [] };
      }
      return { rows: [] };
    });
    pool.connect.mockResolvedValue(client);

    const job = makeJobData({ parsedAmount: 50 }); // offer-1: 50*2=100, offer-2: 50*1=50
    await processMatching(job);

    // Two INSERT calls for matched donations
    const insertCalls = client.query.mock.calls.filter(
      ([sql]) => sql.startsWith("INSERT INTO donations"),
    );
    expect(insertCalls).toHaveLength(2);
    expect(insertCalls[0][1][3]).toBe(100); // offer-1: 50*2
    expect(insertCalls[1][1][3]).toBe(50); // offer-2: 50*1

    // Two UPDATE donation_matches calls
    const updateMatchCalls = client.query.mock.calls.filter(
      ([sql]) => sql.includes("UPDATE donation_matches"),
    );
    expect(updateMatchCalls).toHaveLength(2);
    expect(updateMatchCalls[0][1][0]).toBe(100);
    expect(updateMatchCalls[1][1][0]).toBe(50);

    // PROJECT update should be called with total = 150
    const updateProjectCall = client.query.mock.calls.find(
      ([sql]) => sql.includes("UPDATE projects"),
    );
    expect(updateProjectCall[1][0]).toBe(150);
  });

  // ── Mixed: one offer skipped (cap reached), one processed ──────────────

  test("skips exhausted offers while processing remaining ones", async () => {
    const client = makeMockClient();
    const offers = [
      mockActiveOffer({ id: "offer-exhausted", cap_xlm: "100", matched_xlm: "100", multiplier: 2 }),
      mockActiveOffer({ id: "offer-fresh", cap_xlm: "200", matched_xlm: "0", multiplier: 1 }),
    ];
    client.query.mockImplementation((sql) => {
      if (sql.includes("FROM donation_matches")) {
        return { rows: offers };
      }
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [] };
      }
      return { rows: [] };
    });
    pool.connect.mockResolvedValue(client);

    const job = makeJobData({ parsedAmount: 50 });
    await processMatching(job);

    // Only one INSERT (for the fresh offer, not the exhausted one)
    const insertCalls = client.query.mock.calls.filter(
      ([sql]) => sql.startsWith("INSERT INTO donations"),
    );
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0][1][1]).toBe("proj-1"); // projectId
    expect(insertCalls[0][1][2]).toBe(offers[1].matcher_address); // fresh offer's matcher
    expect(insertCalls[0][1][3]).toBe(50); // 50 * 1 = 50
  });

  // ── Socket.IO emission ─────────────────────────────────────────────────

  test("emits donation_event via Socket.IO when io is configured", async () => {
    const mockIo = { emit: jest.fn() };
    // Re-require to reset module-level `io` variable
    jest.resetModules();
    jest.mock("../db/pool", () => ({ connect: jest.fn() }));
    jest.mock("uuid", () => ({ v4: jest.fn(() => "mock-uuid-1") }));
    jest.mock("../logger", () => ({
      info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
    }));
    jest.mock("pg-boss", () =>
      jest.fn(() => ({
        start: jest.fn().mockResolvedValue(),
        work: jest.fn().mockResolvedValue(),
        send: jest.fn().mockResolvedValue("job-123"),
        stop: jest.fn().mockResolvedValue(),
        on: jest.fn(),
      })),
    );

    const freshPool = require("../db/pool");
    const { processMatching: freshProcessMatching, start: freshStart } =
      require("./matchQueue");

    // Start sets the module-level io
    await freshStart(mockIo);

    const client = makeMockClient();
    client.query.mockImplementation((sql) => {
      if (sql.includes("FROM donation_matches")) {
        return { rows: [mockActiveOffer()] };
      }
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [] };
      }
      return { rows: [] };
    });
    freshPool.connect.mockResolvedValue(client);

    const job = makeJobData({ parsedAmount: 50 });
    await freshProcessMatching(job);

    expect(mockIo.emit).toHaveBeenCalledWith(
      "donation_event",
      expect.objectContaining({
        projectId: "proj-1",
        donorAddress: "matching",
        amountXLM: 100,
        isMatching: true,
      }),
    );
  });

  // ── Error handling ─────────────────────────────────────────────────────

  test("rolls back transaction on error and rethrows", async () => {
    const client = makeMockClient();
    client.query.mockImplementation((sql) => {
      if (sql.includes("FROM donation_matches")) {
        return { rows: [mockActiveOffer()] };
      }
      if (sql === "BEGIN" || sql === "ROLLBACK" || sql === "COMMIT") {
        return { rows: [] };
      }
      if (sql.startsWith("INSERT INTO donations")) {
        throw new Error("DB constraint violation");
      }
      return { rows: [] };
    });
    pool.connect.mockResolvedValue(client);

    const job = makeJobData();
    await expect(processMatching(job)).rejects.toThrow("DB constraint violation");

    // Should have attempted ROLLBACK
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: "matching_error" }),
      expect.any(String),
    );
  });

  test("releases client even if ROLLBACK itself fails", async () => {
    const client = makeMockClient();
    client.query.mockImplementation((sql) => {
      if (sql.includes("FROM donation_matches")) {
        return { rows: [mockActiveOffer()] };
      }
      if (sql === "BEGIN") return { rows: [] };
      if (sql === "ROLLBACK") throw new Error("ROLLBACK failed");
      if (sql === "COMMIT") return { rows: [] };
      if (sql.startsWith("INSERT INTO donations")) {
        throw new Error("Original error");
      }
      return { rows: [] };
    });
    pool.connect.mockResolvedValue(client);

    const job = makeJobData();
    await expect(processMatching(job)).rejects.toThrow("Original error");

    // Client must be released even though ROLLBACK failed
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});

// ── enqueueDonationMatching unit tests ─────────────────────────────────────

describe("matchQueue: enqueueDonationMatching", () => {
  test("throws when boss is not started", async () => {
    await expect(
      enqueueDonationMatching("proj-1", 50, "GAAAA...", "hash"),
    ).rejects.toThrow("matchQueue not started");
  });

  test("calls boss.send with correct arguments after start", async () => {
    // Reset module to get a fresh boss instance
    jest.resetModules();
    jest.mock("../db/pool", () => ({ connect: jest.fn() }));
    jest.mock("uuid", () => ({ v4: jest.fn(() => "mock-uuid-1") }));
    jest.mock("../logger", () => ({
      info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
    }));
    jest.mock("pg-boss", () => {
      const mockBoss = {
        start: jest.fn().mockResolvedValue(),
        work: jest.fn().mockResolvedValue(),
        send: jest.fn().mockResolvedValue("job-456"),
        stop: jest.fn().mockResolvedValue(),
        on: jest.fn(),
      };
      return jest.fn(() => mockBoss);
    });

    const { start: freshStart, enqueueDonationMatching: freshEnqueue } =
      require("./matchQueue");

    await freshStart();

    const jobId = await freshEnqueue("proj-2", 25, "GDONOR...", "txhash");

    expect(jobId).toBe("job-456");
    const mockBossInstance = require("pg-boss").mock.results[0].value;
    expect(mockBossInstance.send).toHaveBeenCalledWith(
      "donation-matching",
      {
        projectId: "proj-2",
        parsedAmount: 25,
        donorAddress: "GDONOR...",
        transactionHash: "txhash",
      },
      { retryLimit: 3, retryDelay: 10 },
    );
  });
});

// ── stop unit tests ─────────────────────────────────────────────────────────

describe("matchQueue: stop", () => {
  test("is a no-op when boss is not started", async () => {
    // Reset to get a fresh module without boss started
    jest.resetModules();
    jest.mock("../db/pool", () => ({ connect: jest.fn() }));
    jest.mock("uuid", () => ({ v4: jest.fn(() => "mock-uuid-1") }));
    jest.mock("../logger", () => ({
      info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
    }));
    jest.mock("pg-boss", () => {
      const mockBoss = {
        start: jest.fn().mockResolvedValue(),
        work: jest.fn().mockResolvedValue(),
        send: jest.fn().mockResolvedValue("job"),
        stop: jest.fn().mockResolvedValue(),
        on: jest.fn(),
      };
      return jest.fn(() => mockBoss);
    });

    const { stop: freshStop } = require("./matchQueue");
    await expect(freshStop()).resolves.toBeUndefined();
  });

  test("calls boss.stop gracefully", async () => {
    jest.resetModules();
    jest.mock("../db/pool", () => ({ connect: jest.fn() }));
    jest.mock("uuid", () => ({ v4: jest.fn(() => "mock-uuid-1") }));
    jest.mock("../logger", () => ({
      info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
    }));
    jest.mock("pg-boss", () => {
      const mockBoss = {
        start: jest.fn().mockResolvedValue(),
        work: jest.fn().mockResolvedValue(),
        send: jest.fn().mockResolvedValue("job"),
        stop: jest.fn().mockResolvedValue(),
        on: jest.fn(),
      };
      return jest.fn(() => mockBoss);
    });

    const { start: freshStart, stop: freshStop } = require("./matchQueue");
    await freshStart();

    await freshStop();

    const mockBossInstance = require("pg-boss").mock.results[0].value;
    expect(mockBossInstance.stop).toHaveBeenCalledWith({
      graceful: true,
      timeout: 15_000,
    });
  });
});
