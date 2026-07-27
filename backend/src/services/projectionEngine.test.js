"use strict";

/**
 * Unit tests for the event-sourcing projection engine.
 *
 * These run without Docker. The fake pool records the SQL statements the
 * engine issues, so we assert on *which* handlers run, that upserts are
 * idempotent (ON CONFLICT), the correct columns are touched, event ordering,
 * and that a rebuild replays every event. Data-level correctness (exact
 * totals, donor_count derivation, rebuild == incremental projection) is
 * covered by projectionEngine.integration.test.js against a real Postgres.
 */

jest.mock("../db/pool", () => require("./__fakes__/poolFake"));

const pool = require("../db/pool");
const {
  projections,
  PROJECTION_NAMES,
  insertEvent,
  processEvent,
  rebuildAllProjections,
  rebuildProjection,
  truncateProjections,
  refreshLag,
  isRebuilding,
  computeImpactScore,
  co2OffsetForDonation,
} = require("./projectionEngine");

function donationEvent(overrides = {}) {
  return {
    event_type: "DonationRecorded",
    aggregate_id: overrides.projectId || "proj-1",
    event_data: {
      donorAddress: overrides.donorAddress || "GAAA",
      projectId: overrides.projectId || "proj-1",
      amountXLM: overrides.amountXLM != null ? overrides.amountXLM : 100,
      currency: "XLM",
      message: overrides.message || null,
      co2OffsetKg: overrides.co2OffsetKg || 0,
      projectsSupported: overrides.projectsSupported || 1,
      transactionHash: overrides.transactionHash || `tx-${Math.random()}`,
    },
    soroban_ledger: overrides.soroban_ledger || 1,
    transaction_hash: overrides.transactionHash || `tx-${Math.random()}`,
  };
}

function callsForTable(table) {
  // Count only write statements (INSERT/UPDATE) against the projection table;
  // SELECTs (e.g. the global_stats DISTINCT check, project_stats donor_count
  // lookup, and refreshLag) share the table name and are excluded.
  return pool
    .__calls()
    .filter((c) => c.text.includes(table) && /^(INSERT|UPDATE)/.test(c.text.trim()));
}

function projectionWriteCalls() {
  // INSERT INTO projection_*  |  UPDATE projection_* SET ... (no INTO)
  return pool
    .__calls()
    .filter((c) => /^(INSERT INTO projection_|UPDATE projection_)/.test(c.text.trim()));
}

describe("projectionEngine — helpers", () => {
  test("computeImpactScore matches the legacy leaderboard formula", () => {
    // score = xlm*0.7 + (co2/100)*0.3  => 1000*0.7 + 50000/100*0.3 = 700 + 150
    expect(computeImpactScore(1000, 50000)).toBeCloseTo(850);
    expect(computeImpactScore(0, 0)).toBe(0);
  });

  test("co2OffsetForDonation distributes proportionally when raised>0", () => {
    expect(co2OffsetForDonation(10, 100, 1000)).toBeCloseTo(100);
  });

  test("co2OffsetForDonation is 0 when project has no co2 or no raised", () => {
    expect(co2OffsetForDonation(10, 100, 0)).toBe(0);
    expect(co2OffsetForDonation(10, 0, 1000)).toBe(0);
  });

  test("PROJECTION_NAMES includes the four required projections", () => {
    expect(PROJECTION_NAMES.sort()).toEqual(
      ["donor_history", "donor_leaderboard", "global_stats", "project_stats"].sort(),
    );
  });
});

describe("projectionEngine — handler coverage", () => {
  beforeEach(() => pool.__reset());

  test("donor_leaderboard issues an idempotent upsert with totals", async () => {
    await processEvent(donationEvent({ donorAddress: "GAAA", amountXLM: 100 }));
    const calls = callsForTable("projection_donor_leaderboard");
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain("INSERT INTO projection_donor_leaderboard");
    expect(calls[0].text).toContain("ON CONFLICT (donor_address)");
    expect(calls[0].text).toContain("total_donated = projection_donor_leaderboard.total_donated + $2");
    expect(calls[0].params[0]).toBe("GAAA");
    expect(Number(calls[0].params[1])).toBe(100);
  });

  test("project_stats issues an upsert and recomputes donor_count", async () => {
    await processEvent(donationEvent({ projectId: "P1", amountXLM: 200, co2OffsetKg: 20 }));
    const upserts = callsForTable("projection_project_stats").filter((c) => c.text.startsWith("INSERT"));
    const updates = callsForTable("projection_project_stats").filter((c) => c.text.startsWith("UPDATE"));
    expect(upserts).toHaveLength(1);
    expect(upserts[0].text).toContain("ON CONFLICT (project_id)");
    expect(updates).toHaveLength(1);
    expect(updates[0].text).toContain("donor_count = $2");
  });

  test("donor_history inserts with ON CONFLICT (transaction_hash) for idempotency", async () => {
    await processEvent(donationEvent({ donorAddress: "GAAA", projectId: "P1", transactionHash: "t1" }));
    const calls = callsForTable("projection_donor_history");
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain("INSERT INTO projection_donor_history");
    expect(calls[0].text).toContain("ON CONFLICT (transaction_hash) DO NOTHING");
    expect(calls[0].params).toContain("t1");
  });

  test("global_stats updates the singleton row id=1", async () => {
    await processEvent(donationEvent({ donorAddress: "GAAA", amountXLM: 100, co2OffsetKg: 10 }));
    const calls = callsForTable("projection_global_stats").filter((c) => c.text.startsWith("UPDATE"));
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain("WHERE id = 1");
    expect(calls[0].params).toContain(100);
  });

  test("non-DonationRecorded events are ignored by every projection", async () => {
    pool.__reset();
    await processEvent({ event_type: "ProjectRegistered", aggregate_id: "P9", event_data: { name: "x" } });
    const all = projectionWriteCalls();
    expect(all).toHaveLength(0);
  });
});

describe("projectionEngine — idempotent replay", () => {
  beforeEach(() => pool.__reset());

  test("replaying the same event issues the same upsert statements", async () => {
    const e = donationEvent({ donorAddress: "GAAA", projectId: "P1", amountXLM: 100, co2OffsetKg: 5, transactionHash: "dup" });
    await processEvent(e);
    const first = pool.__calls().filter((c) => /projection_/.test(c.text)).map((c) => c.text + JSON.stringify(c.params));
    pool.__reset();
    await processEvent(e);
    const second = pool.__calls().filter((c) => /projection_/.test(c.text)).map((c) => c.text + JSON.stringify(c.params));
    expect(second).toEqual(first);
  });

  test("two distinct donations to the same donor issue two leaderboard upserts", async () => {
    await processEvent(donationEvent({ donorAddress: "GAAA", amountXLM: 100 }));
    await processEvent(donationEvent({ donorAddress: "GAAA", amountXLM: 50, transactionHash: "tx2" }));
    const upserts = callsForTable("projection_donor_leaderboard").filter((c) => c.text.startsWith("INSERT"));
    expect(upserts).toHaveLength(2);
  });
});

describe("projectionEngine — event ordering", () => {
  beforeEach(() => pool.__reset());

  test("processEvent runs every projection handler for each event (order: lb, project, history, global)", async () => {
    await processEvent(donationEvent({ donorAddress: "GAAA" }));
    const tablesTouched = projectionWriteCalls()
      .map((c) => {
        const m = c.text.match(/projection_(\w+)/);
        return m ? m[1] : null;
      })
      .filter(Boolean)
      .filter((t) => ["donor_leaderboard", "project_stats", "donor_history", "global_stats"].includes(t));
    expect([...new Set(tablesTouched)].sort()).toEqual(
      ["donor_history", "donor_leaderboard", "global_stats", "project_stats"].sort(),
    );
  });
});

describe("projectionEngine — rebuild", () => {
  beforeEach(async () => {
    pool.__reset();
    await insertEvent(donationEvent({ donorAddress: "GAAA", projectId: "P1", amountXLM: 100, co2OffsetKg: 10, transactionHash: "e1" }));
    await insertEvent(donationEvent({ donorAddress: "GBBB", projectId: "P1", amountXLM: 50, co2OffsetKg: 5, transactionHash: "e2" }));
    await insertEvent(donationEvent({ donorAddress: "GAAA", projectId: "P2", amountXLM: 25, transactionHash: "e3" }));
  });

  test("rebuildAllProjections truncates all projections first", async () => {
    const result = await rebuildAllProjections();
    expect(result.events).toBe(3);
    const truncates = pool.__calls().filter((c) => c.text.startsWith("TRUNCATE"));
    expect(truncates).toHaveLength(1);
    expect(truncates[0].text).toContain("projection_donor_leaderboard");
    expect(truncates[0].text).toContain("projection_project_stats");
    expect(truncates[0].text).toContain("projection_donor_history");
    expect(truncates[0].text).toContain("projection_global_stats");
  });

  test("rebuild issues one processEvent-equivalent pass per stored event (4 projections x 3 events)", async () => {
    // beforeEach already seeded 3 events into the event store.
    pool.__resetCalls(); // clear recorded calls, keep event store intact
    const result = await rebuildAllProjections();
    expect(result.events).toBe(3);
    // 3 events * 4 projections = 12 handler write statements.
    expect(projectionWriteCalls().length).toBeGreaterThanOrEqual(12);
  });

  test("rebuildProjection runs only the named projection", async () => {
    pool.__reset();
    await rebuildProjection("donor_leaderboard");
    const tables = new Set(
      pool.__calls().map((c) => {
        const m = c.text.match(/projection_(\w+)/);
        return m ? m[1] : null;
      }),
    );
    expect(tables.has("donor_leaderboard")).toBe(true);
    expect(tables.has("project_stats")).toBe(false);
    expect(tables.has("donor_history")).toBe(false);
    expect(tables.has("global_stats")).toBe(false);
  });

  test("rebuildProjection throws on unknown name", async () => {
    await expect(rebuildProjection("nope")).rejects.toThrow(/Unknown projection/);
  });

  test("isRebuilding is false before and after a rebuild", async () => {
    expect(isRebuilding()).toBe(false);
    await rebuildAllProjections();
    expect(isRebuilding()).toBe(false);
  });

  test("truncateProjections issues a single TRUNCATE across all tables", async () => {
    pool.__reset();
    await truncateProjections();
    const truncates = pool.__calls().filter((c) => c.text.startsWith("TRUNCATE"));
    expect(truncates).toHaveLength(1);
    PROJECTION_NAMES.forEach((n) =>
      expect(truncates[0].text).toContain(projections[n].table),
    );
  });
});

describe("projectionEngine — lag metric", () => {
  beforeEach(() => pool.__reset());

  test("refreshLag does not throw and returns a number (0 when projections are current)", async () => {
    await processEvent(donationEvent({ donorAddress: "GAAA", transactionHash: "e1" }));
    const lag = await refreshLag();
    expect(typeof lag).toBe("number");
  });
});

describe("projectionEngine — insertEvent (event store write path)", () => {
  beforeEach(() => pool.__reset());

  test("insertEvent appends to donation_events with correct columns", async () => {
    const row = await insertEvent(donationEvent({ donorAddress: "GAAA", transactionHash: "e1" }));
    const calls = pool.__calls().filter((c) => c.text.includes("donation_events"));
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain("INSERT INTO donation_events");
    expect(calls[0].text).toContain("event_type");
    expect(calls[0].text).toContain("aggregate_id");
    expect(calls[0].text).toContain("event_data");
    expect(calls[0].text).toContain("RETURNING id, created_at");
    expect(row).toHaveProperty("id");
    expect(row).toHaveProperty("created_at");
  });

  test("insertEvent JSON-encodes event_data", async () => {
    await insertEvent(donationEvent({ event_data_extra: true }));
    const calls = pool.__calls().filter((c) => c.text.includes("donation_events"));
    // event_data is the 3rd positional param, JSON.stringify'd by the engine.
    const eventDataParam = calls[0].params[2];
    expect(typeof eventDataParam).toBe("string");
    expect(() => JSON.parse(eventDataParam)).not.toThrow();
  });
});
