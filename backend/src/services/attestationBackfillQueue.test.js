"use strict";

/**
 * backend/src/services/attestationBackfillQueue.test.js
 *
 * Unit tests for the on-chain id back-fill worker (issue #125 follow-up).
 * The pg pool + Soroban RPC + pg-boss are fully mocked so the tests
 * isolate the decode / match / cursor logic.
 */

jest.mock("pg-boss", () => {
  let lastInstance = null;
  class FakeBoss {
    constructor() {
      this.started = false;
      this.sent = [];
      this.worked = null;
      this.workOptions = null;
      this.handlers = {};
      lastInstance = this;
    }
    async start() {
      this.started = true;
    }
    async work(queue, options, handler) {
      this.worked = { queue, handler };
      this.workOptions = options;
    }
    async send(queue, data, options) {
      this.sent.push({ queue, data, options });
      return `sweep-${this.sent.length}`;
    }
    async stop() {
      this.started = false;
      lastInstance = null;
    }
    on(event, handler) {
      // EventEmitter-ish interface: stash handlers so tests can inspect
      // them. The production code wires `boss.on("error", …)`.
      this.handlers[event] = handler;
      return this;
    }
  }
  // Read-only accessor for tests that want to inspect the most recent
  // instance. Module-scoped so subsequent constructors always overwrite.
  Object.defineProperty(FakeBoss, "__instance", {
    configurable: true,
    enumerable: true,
    get() {
      return lastInstance;
    },
    set(v) {
      // Tests reset via __instance = null
      lastInstance = v;
    },
  });
  return FakeBoss;
});

jest.mock("../db/pool", () => ({
  query: jest.fn(),
}));

jest.mock("../logger", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock("./stellar", () => ({
  rpcServer: { getEvents: jest.fn(), getLatestLedger: jest.fn() },
  withRetry: (fn) => fn(),
  xdr: {
    ScVal: {
      fromXDR: (_buf, _enc) => ({ __decoded: true }),
      scvSymbol: () => ({ toXDR: () => "BASE64-SYMBOL-ATT_NEW" }),
    },
  },
  scValToNative: (scv) => {
    // The test fixtures use sentinel objects; map them to usable JS values.
    if (!scv) return scv;
    if (scv.__decoded) return scv.__value;
    if (typeof scv === "object" && "__value" in scv) return scv.__value;
    return scv;
  },
}));

jest.mock("./metrics", () => ({
  attestationBackfillUpdatesTotal: { inc: jest.fn() },
  attestationBackfillPollsTotal: { inc: jest.fn() },
  attestationBackfillCursorLag: { set: jest.fn() },
}));

const PgBoss = require("pg-boss");
const pool = require("../db/pool");
const stellar = require("./stellar");
const metrics = require("./metrics");

const backfill = require("./attestationBackfillQueue");

// Default every un-set-up pool.query call to a harmless empty rows
// shape so a test that forgets a mock doesn't crash on destructuring.
const originalPoolQuery = pool.query;
beforeAll(() => {
  pool.query = jest.fn().mockResolvedValue({ rows: [] });
});
afterAll(() => {
  pool.query = originalPoolQuery;
});

const sampleEvent = {
  ledger: 12345,
  topic: [
    { __value: "att_new" },
    { __value: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    { __value: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" },
    { __value: "ethereum" },
  ],
  // i128 amounts come back as strings to preserve precision (see
  // toBigIntString in the implementation under test).
  value: { __value: [42, "project-x", "10", "80"] },
};

beforeEach(async () => {
  jest.clearAllMocks();
  PgBoss.__instance = null;
  // Drain any prior-test stub worker before each so the module-scoped
  // `boss` guard in services/attestationBackfillQueue.start() doesn't
  // leak between tests. The call is a no-op when nothing was started.
  await backfill.stop().catch(() => {});
  process.env.ATTESTATION_BACKFILL_ENABLED = "true";
  process.env.ATTESTATION_CONTRACT_ID = "C-TEST-CONTRACT";
});

describe("decodeAttNew", () => {
  test("extracts the canonical fields from a well-formed event", () => {
    const decoded = backfill.decodeAttNew(sampleEvent);
    expect(decoded).toEqual({
      relayer: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      donor: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      sourceChain: "ethereum",
      id: 42,
      projectId: "project-x",
      amountUsd: "10", // BigInt / number / string all coerced to decimal string
      amountXlm: "80",
      ledger: 12345,
    });
  });

  test("handles BigInt-shaped i128 amounts (no precision loss)", () => {
    const big = 12345678901234567890n;
    const evt = JSON.parse(JSON.stringify(sampleEvent));
    evt.value = { __value: [42, "project-x", big, big] };
    const decoded = backfill.decodeAttNew(evt);
    expect(decoded.amountUsd).toBe(big.toString());
    expect(decoded.amountXlm).toBe(big.toString());
  });

  test("returns null when topic[0] is not att_new", () => {
    const evt = JSON.parse(JSON.stringify(sampleEvent));
    evt.topic[0] = { __value: "att_vfy" };
    expect(backfill.decodeAttNew(evt)).toBeNull();
  });

  test("returns null when value is not a 4-tuple", () => {
    const evt = JSON.parse(JSON.stringify(sampleEvent));
    evt.value = { __value: [42, "project-x"] };
    expect(backfill.decodeAttNew(evt)).toBeNull();
  });

  test("returns null when event is malformed", () => {
    expect(backfill.decodeAttNew(null)).toBeNull();
    expect(backfill.decodeAttNew({})).toBeNull();
  });
});

describe("loadCursor / writeCursor", () => {
  test("returns default zero cursor when row absent", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const c = await backfill.loadCursor();
    expect(c).toEqual({
      lastLedger: 0,
      lastRunAt: null,
      lastStatus: null,
      lastError: null,
    });
  });

  test("parses a non-zero persisted cursor", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [
        {
          last_ledger: 999,
          last_run_at: new Date(),
          last_status: "ok",
          last_error: null,
        },
      ],
    });
    const c = await backfill.loadCursor();
    expect(c.lastLedger).toBe(999);
    expect(c.lastStatus).toBe("ok");
  });

  test("writeCursor issues the exact UPDATE", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    await backfill.writeCursor({
      lastLedger: 1234,
      lastStatus: "ok",
      lastError: null,
    });
    expect(pool.query.mock.calls[0][0]).toMatch(/UPDATE attestation_backfill_state/);
    expect(pool.query.mock.calls[0][1]).toEqual([
      "attestation_events",
      1234,
      "ok",
      null,
    ]);
  });
});

describe("applyEvent", () => {
  test("returns the row id and increments matched counter on hit", async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: "row-1" }] });
    const result = await backfill.applyEvent({
      id: 42,
      sourceChain: "ethereum",
      donor: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      projectId: "project-x",
      amountUsd: "10",
      amountXlm: "80",
    });
    expect(result).toBe("row-1");
    expect(metrics.attestationBackfillUpdatesTotal.inc).toHaveBeenCalledWith({
      outcome: "matched",
    });
  });

  test("preserves precision on 16+ digit stringified amounts (regression)", async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: "row-3" }] });
    const big = "12345678901234567890"; // exceeds Number.MAX_SAFE_INTEGER (2^53 ≈ 9e15).
    await backfill.applyEvent({
      id: 7,
      sourceChain: "ethereum",
      donor: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      projectId: "project-x",
      amountUsd: big,
      amountXlm: big,
    });
    // The full string must reach PostgreSQL untouched so the ::numeric cast
    // can hold the precision; a Number() roundtrip in JS would silently
    // truncate it.
    expect(pool.query.mock.calls[0][1][4]).toBe(big);
    expect(pool.query.mock.calls[0][1][5]).toBe(big);
  });

  test("uses stringified amounts in the SQL query", async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: "row-2" }] });
    await backfill.applyEvent({
      id: 99,
      sourceChain: "ethereum",
      donor: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      projectId: "project-x",
      amountUsd: "12345678901234567890",
      amountXlm: "80",
    });
    expect(pool.query.mock.calls[0][1]).toEqual([
      99,
      "ethereum",
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "project-x",
      "12345678901234567890",
      "80",
    ]);
  });

  test("returns null and bumps miss counter on no rows updated", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const result = await backfill.applyEvent({
      id: 42,
      sourceChain: "ethereum",
      donor: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      projectId: "project-x",
      amountUsd: "10",
      amountXlm: "80",
    });
    expect(result).toBeNull();
    expect(metrics.attestationBackfillUpdatesTotal.inc).toHaveBeenCalledWith({
      outcome: "miss",
    });
  });

  test("raises + bumps error counter when the UPDATE fails", async () => {
    pool.query.mockRejectedValueOnce(new Error("boom"));
    await expect(
      backfill.applyEvent({
        id: 42,
        sourceChain: "ethereum",
        donor: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        projectId: "project-x",
        amountUsd: "10",
        amountXlm: "80",
      }),
    ).rejects.toThrow(/boom/);
    expect(metrics.attestationBackfillUpdatesTotal.inc).toHaveBeenCalledWith({
      outcome: "error",
    });
  });
});

describe("fetchEventsSince", () => {
  test("returns empty shape when contract id env is unset", async () => {
    delete process.env.ATTESTATION_CONTRACT_ID;
    delete process.env.CONTRACT_ID;
    const r = await backfill.fetchEventsSince(0);
    expect(r).toEqual({ events: [], head: 0 });
    expect(stellar.rpcServer.getEvents).not.toHaveBeenCalled();
  });

  test("decodes the events returned by getEvents", async () => {
    process.env.ATTESTATION_CONTRACT_ID = "C-TEST";
    stellar.rpcServer.getLatestLedger.mockResolvedValueOnce({ sequence: 200 });
    stellar.rpcServer.getEvents.mockResolvedValueOnce({
      events: [sampleEvent, sampleEvent],
    });
    const r = await backfill.fetchEventsSince(100);
    expect(r.events.length).toBe(2);
    expect(r.events[0].id).toBe(42);
    expect(r.head).toBe(200);
  });

  test("tolerates RPC errors and rethrows", async () => {
    stellar.rpcServer.getLatestLedger.mockResolvedValueOnce({ sequence: 200 });
    stellar.rpcServer.getEvents.mockRejectedValueOnce(new Error("rpc down"));
    await expect(backfill.fetchEventsSince(0)).rejects.toThrow(/rpc down/);
  });
});

describe("start / stop", () => {
  test("start is a no-op when ATTESTATION_BACKFILL_ENABLED=false", async () => {
    process.env.ATTESTATION_BACKFILL_ENABLED = "false";
    await backfill.start();
    expect(PgBoss.__instance).toBeNull();
  });

  test("start is a no-op when ATTESTATION_CONTRACT_ID is missing", async () => {
    delete process.env.ATTESTATION_CONTRACT_ID;
    delete process.env.CONTRACT_ID;
    await backfill.start();
    expect(PgBoss.__instance).toBeNull();
  });

  test("start registers the worker + sends the kickoff poll", async () => {
    await backfill.start();
    expect(PgBoss.__instance).not.toBeNull();
    expect(PgBoss.__instance.started).toBe(true);
    expect(PgBoss.__instance.worked.queue).toBe("attestation-backfill");
    // start() schedules one immediate poll so the worker is warm on boot.
    expect(PgBoss.__instance.sent.length).toBeGreaterThanOrEqual(1);
    expect(PgBoss.__instance.sent[0].data).toEqual({ kind: "poll" });
  });

  test("stop drains pg-boss and clears singleton", async () => {
    await backfill.start();
    const bossInstance = PgBoss.__instance;
    await backfill.stop();
    expect(bossInstance.started).toBe(false);
    expect(PgBoss.__instance).toBeNull();
  });
});

describe("tick (single iteration)", () => {
  test("advances the cursor when events match", async () => {
    process.env.ATTESTATION_CONTRACT_ID = "C-TEST";
    stellar.rpcServer.getLatestLedger.mockResolvedValueOnce({ sequence: 200 });
    stellar.rpcServer.getEvents.mockResolvedValueOnce({
      events: [sampleEvent],
    });
    pool.query
      .mockResolvedValueOnce({ rows: [{ last_ledger: 0 }] }) // loadCursor
      .mockResolvedValueOnce({ rows: [{ id: "row-1" }] }) // applyEvent
      .mockResolvedValueOnce({ rows: [] }); // writeCursor

    await backfill.tick();
    expect(metrics.attestationBackfillUpdatesTotal.inc).toHaveBeenCalledWith({
      outcome: "matched",
    });
    expect(metrics.attestationBackfillPollsTotal.inc).toHaveBeenCalledWith({
      outcome: "progress",
    });
  });

  test("idles the poll when zero events match", async () => {
    stellar.rpcServer.getLatestLedger.mockResolvedValueOnce({ sequence: 200 });
    stellar.rpcServer.getEvents.mockResolvedValueOnce({ events: [] });
    pool.query.mockResolvedValueOnce({ rows: [{ last_ledger: 0 }] });
    pool.query.mockResolvedValueOnce({ rows: [] }); // writeCursor no-progress

    await backfill.tick();
    expect(metrics.attestationBackfillPollsTotal.inc).toHaveBeenCalledWith({
      outcome: "idle",
    });
  });

  test("records the error path without advancing the cursor", async () => {
    // After the refactor, getLedgerHead swallows RPC errors and returns
    // 0; the test now fails getEvents instead so fetchEventsSince throws
    // and runOnce falls into the error branch.
    stellar.rpcServer.getLatestLedger.mockResolvedValue({ sequence: 200 });
    stellar.rpcServer.getEvents.mockRejectedValueOnce(new Error("rpc nope"));
    pool.query.mockResolvedValueOnce({ rows: [{ last_ledger: 100 }] }); // loadCursor
    pool.query.mockResolvedValueOnce({ rows: [] }); // writeCursor error

    await backfill.tick();
    expect(metrics.attestationBackfillPollsTotal.inc).toHaveBeenCalledWith({
      outcome: "error",
    });
  });
});
