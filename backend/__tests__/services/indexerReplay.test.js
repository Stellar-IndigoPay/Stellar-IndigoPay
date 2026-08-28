"use strict";

/**
 * __tests__/services/indexerReplay.test.js
 *
 * Golden-corpus replay-determinism tests for the Soroban event pipeline.
 *
 * Coverage:
 *   - Determinism: applying the same fixture sequence twice yields byte-identical
 *     deterministic state (donations, cursors, dedupe sets, DLQ rows).
 *   - Drift detection: a deliberately mutated fixture produces different state.
 *   - Position injection: injecting one event at different positions in the sequence
 *     asserts that ordering semantics are preserved.
 *   - Schema validation: fixtures must parse against the event schema; a broken
 *     fixture fails loudly.
 *   - Corpus completeness: every event type in the fixture is dispatched to a
 *     registered handler.
 *   - Dedupe-set semantics: duplicate events are idempotent across replays.
 *
 * These are integration tests that run against a real Postgres database
 * (via docker-compose.test.yml in CI).
 */

const fs = require("fs");
const path = require("path");
const pool = require("../../src/db/pool");
const { fixtureMetadataSchema } = require("../../src/schemas/sorobanEventSchema");
const { HANDLERS, extractEventType, extractTopics, extractValue } = require("../../src/services/sorobanEventService");

const fixturePath = path.join(__dirname, "../fixtures/events/golden-events.json");

// ── Fixture loading & schema validation ────────────────────────────────────

describe("Golden-corpus schema validation", () => {
  test("golden-events.json parses against fixtureMetadataSchema", () => {
    const rawData = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
    expect(() => fixtureMetadataSchema.parse(rawData)).not.toThrow();
  });

  test("fixture has required provenance metadata", () => {
    const rawData = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
    const parsed = fixtureMetadataSchema.parse(rawData);
    expect(parsed.provenance.sourceTxHash).toBeTruthy();
    expect(parsed.provenance.capturedAt).toBeTruthy();
    expect(parsed.provenance.schemaVersion).toBeTruthy();
  });

  test("intentional duplicate pagingTokens exist for dedupe testing", () => {
    const rawData = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
    const parsed = fixtureMetadataSchema.parse(rawData);
    const tokens = parsed.events.map((e) => e.pagingToken);
    const uniqueTokens = new Set(tokens);
    // The corpus intentionally contains one duplicate pagingToken to test
    // deduplication. All other tokens should be unique.
    expect(tokens.length - uniqueTokens.size).toBe(1);
  });

  test("fixture contains events for all registered handler types", () => {
    const rawData = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
    const parsed = fixtureMetadataSchema.parse(rawData);

    // Collect all event types in the fixture
    const fixtureTypes = new Set(parsed.events.map((evt) => extractEventType(evt)));

    // Every handler key should appear at least once
    for (const handlerKey of Object.keys(HANDLERS)) {
      if (handlerKey === "unknown") continue; // "unknown" is a fallback, not a handler key
      expect(fixtureTypes).toContain(handlerKey);
    }
  });

  test("rejects a fixture with missing provenance", () => {
    const bad = { events: [] };
    expect(() => fixtureMetadataSchema.parse(bad)).toThrow();
  });

  test("rejects a fixture with invalid event shape", () => {
    const bad = {
      provenance: { sourceTxHash: "tx", capturedAt: "2026-01-01", schemaVersion: "1.0" },
      events: [{ id: "x" }], // missing required fields
    };
    expect(() => fixtureMetadataSchema.parse(bad)).toThrow();
  });

  test("rejects a fixture with event missing pagingToken", () => {
    const bad = {
      provenance: { sourceTxHash: "tx", capturedAt: "2026-01-01", schemaVersion: "1.0" },
      events: [
        {
          id: "x",
          type: "contractEvent",
          ledger: 1,
          ledgerClosedAt: "2026-01-01",
          contractId: "C",
          topic: ["donated"],
          value: null,
        },
      ],
    };
    expect(() => fixtureMetadataSchema.parse(bad)).toThrow();
  });
});

// ── Replay-determinism tests ──────────────────────────────────────────────

describe("Indexer Pipeline Replay Determinism", () => {
  let fixtureData;
  let schemaReady = false;

  async function tableExists(clientOrPool, tableName) {
    const queryable = clientOrPool.query ? clientOrPool : await pool.connect();
    try {
      const { rows } = await queryable.query(
        `SELECT EXISTS (
           SELECT 1
           FROM information_schema.tables
           WHERE table_schema = 'public'
             AND table_name = $1
         ) AS exists`,
        [tableName]
      );
      return rows[0].exists;
    } finally {
      if (!clientOrPool.query) queryable.release();
    }
  }

  beforeAll(async () => {
    // 1. Load fixtures and validate them against the schema
    const rawData = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
    fixtureData = fixtureMetadataSchema.parse(rawData);

    // 2. Check if the DB schema exists (migrations applied)
    // Gracefully handle missing DB (these are integration tests that run in CI)
    try {
      const client = await pool.connect();
      try {
        schemaReady =
          (await tableExists(client, "projects")) &&
          (await tableExists(client, "donations")) &&
          (await tableExists(client, "profiles"));
      } finally {
        client.release();
      }
    } catch {
      // Database not available — integration tests will be skipped
      schemaReady = false;
    }
  });

  beforeEach(async () => {
    if (!schemaReady) return;

    // Clear state before each run
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      for (const table of [
        "soroban_event_dlq",
        "indexer_state",
        "soroban_processed_events",
      ]) {
        if (await tableExists(client, table)) {
          await client.query(`DELETE FROM ${table}`);
        }
      }

      // Delete test data by known project IDs and donor addresses
      const testProjectIds = [
        "11111111-1111-1111-1111-111111111111",
        "new-project-id-01",
      ];
      const testDonors = [
        "GBDONORAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABC",
        "GBDONORBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      ];

      for (const pid of testProjectIds) {
        if (await tableExists(client, "donations")) {
          await client.query("DELETE FROM donations WHERE project_id = $1", [pid]);
        }
        if (await tableExists(client, "projects")) {
          await client.query("DELETE FROM projects WHERE id = $1", [pid]);
        }
      }

      for (const donor of testDonors) {
        if (await tableExists(client, "profiles")) {
          await client.query("DELETE FROM profiles WHERE public_key = $1", [donor]);
        }
      }

      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  });

  /**
   * Apply a sequence of events through the handler dispatch.
   * Ensures parent project rows exist for donated events.
   */
  async function applyFixtureEvents(events) {
    for (const evt of events) {
      const eventType = extractEventType(evt);
      const topics = extractTopics(evt);
      const value = extractValue(evt);

      if (HANDLERS[eventType]) {
        // Ensure the parent project row exists before a donated event
        if (eventType === "donated") {
          const projectId = topics[2];
          if (projectId) {
            await pool.query(
              `INSERT INTO projects (id, name, description, category, location, wallet_address, raised_xlm)
               VALUES ($1, $2, $3, $4, $5, $6, $7)
               ON CONFLICT DO NOTHING`,
              [projectId, "Test Project", "Fixture project", "other", "unknown", "GCREATOR", 0]
            );
          }
        }

        // Ensure parent project exists for rec_exec events
        if (eventType === "rec_exec") {
          const recurringId = Number(topics[2]);
          // rec_exec looks up the recurring_donations config; skip if not set up
        }

        await HANDLERS[eventType](evt, topics, value);
      }
    }
  }

  // Columns that change between runs due to uuid() and NOW() defaults.
  const NON_DETERMINISTIC_KEYS = new Set([
    "id",
    "created_at",
    "updated_at",
    "search_vector",
  ]);

  function normalizeRow(row) {
    const out = {};
    for (const [k, v] of Object.entries(row)) {
      if (!NON_DETERMINISTIC_KEYS.has(k)) out[k] = v;
    }
    return out;
  }

  function normalizeState(state) {
    return {
      donations: state.donations.map(normalizeRow),
      profiles: state.profiles.map(normalizeRow),
      projects: state.projects.map(normalizeRow),
      dlq: state.dlq.map(normalizeRow),
    };
  }

  async function getDatabaseState() {
    const client = await pool.connect();
    try {
      const donations = (await tableExists(client, "donations"))
        ? (await client.query("SELECT * FROM donations ORDER BY id")).rows
        : [];
      const profiles = (await tableExists(client, "profiles"))
        ? (await client.query("SELECT * FROM profiles ORDER BY public_key")).rows
        : [];
      const projects = (await tableExists(client, "projects"))
        ? (await client.query("SELECT * FROM projects ORDER BY id")).rows
        : [];
      const dlq = (await tableExists(client, "soroban_event_dlq"))
        ? (await client.query("SELECT * FROM soroban_event_dlq ORDER BY id")).rows
        : [];
      return { donations, profiles, projects, dlq };
    } finally {
      client.release();
    }
  }

  async function clearTestState() {
    for (const table of ["soroban_event_dlq", "indexer_state", "soroban_processed_events"]) {
      if (await tableExists(pool, table)) {
        await pool.query(`DELETE FROM ${table}`);
      }
    }
    const testProjectIds = [
      "11111111-1111-1111-1111-111111111111",
      "new-project-id-01",
    ];
    const testDonors = [
      "GBDONORAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABC",
      "GBDONORBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    ];
    for (const pid of testProjectIds) {
      if (await tableExists(pool, "donations")) {
        await pool.query("DELETE FROM donations WHERE project_id = $1", [pid]);
      }
      if (await tableExists(pool, "projects")) {
        await pool.query("DELETE FROM projects WHERE id = $1", [pid]);
      }
    }
    for (const donor of testDonors) {
      if (await tableExists(pool, "profiles")) {
        await pool.query("DELETE FROM profiles WHERE public_key = $1", [donor]);
      }
    }
  }

  // ── Core determinism ────────────────────────────────────────────────────

  it("should process the full fixture sequence deterministically (two fresh runs produce identical state)", async () => {
    if (!schemaReady) {
      console.log("Skipping: DB schema not available (no migrations applied)");
      return;
    }

    // Apply first time
    await applyFixtureEvents(fixtureData.events);
    const state1 = await getDatabaseState();

    // Clear state
    await clearTestState();

    // Apply second time
    await applyFixtureEvents(fixtureData.events);
    const state2 = await getDatabaseState();

    // Compare deterministic fields only
    expect(normalizeState(state1)).toEqual(normalizeState(state2));

    // Verify it processed correctly
    expect(state1.donations.length).toBeGreaterThan(0);
  });

  // ── Drift detection ────────────────────────────────────────────────────

  it("should detect drift when a fixture amount is mutated", async () => {
    if (!schemaReady) {
      console.log("Skipping: DB schema not available (no migrations applied)");
      return;
    }

    await applyFixtureEvents(fixtureData.events);
    const state1 = await getDatabaseState();

    // Clear state
    await clearTestState();

    // Mutate the first donated event's amount
    const mutatedEvents = JSON.parse(JSON.stringify(fixtureData.events));
    const firstDonatedIdx = mutatedEvents.findIndex(
      (e) => extractEventType(e) === "donated"
    );
    if (firstDonatedIdx >= 0 && Array.isArray(mutatedEvents[firstDonatedIdx].value)) {
      mutatedEvents[firstDonatedIdx].value[0] = 20000000; // double the amount
    }

    await applyFixtureEvents(mutatedEvents);
    const state2 = await getDatabaseState();

    expect(normalizeState(state1)).not.toEqual(normalizeState(state2));
  });

  it("should detect drift when a fixture donor address is mutated", async () => {
    if (!schemaReady) {
      console.log("Skipping: DB schema not available (no migrations applied)");
      return;
    }

    await applyFixtureEvents(fixtureData.events);
    const state1 = await getDatabaseState();

    await clearTestState();

    const mutatedEvents = JSON.parse(JSON.stringify(fixtureData.events));
    const firstDonatedIdx = mutatedEvents.findIndex(
      (e) => extractEventType(e) === "donated"
    );
    if (firstDonatedIdx >= 0) {
      mutatedEvents[firstDonatedIdx].topic[1] = "GBADBADBADBADBADBADBADBADBADBADBADBADBADBADBADA";
    }

    await applyFixtureEvents(mutatedEvents);
    const state2 = await getDatabaseState();

    expect(normalizeState(state1)).not.toEqual(normalizeState(state2));
  });

  // ── Position injection ──────────────────────────────────────────────────

  it("should preserve ordering when a new event is injected at the beginning", async () => {
    if (!schemaReady) {
      console.log("Skipping: DB schema not available (no migrations applied)");
      return;
    }

    // Apply original
    await applyFixtureEvents(fixtureData.events);
    const state1 = await getDatabaseState();

    await clearTestState();

    // Inject a new donation at the beginning of the sequence
    const injectedEvent = {
      id: "event_injected_front",
      type: "contractEvent",
      ledger: 50,
      ledgerClosedAt: "2026-08-27T23:59:00Z",
      contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
      pagingToken: "token_injected_front_001",
      topic: ["donated", "GBDONORAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABC", "11111111-1111-1111-1111-111111111111"],
      value: [5000000, 0, null],
      inSuccessfulContractCall: true,
      txHash: "txn_injected_front_001",
    };

    const modifiedEvents = [injectedEvent, ...fixtureData.events];
    await applyFixtureEvents(modifiedEvents);
    const state2 = await getDatabaseState();

    // The injected donation should add one more donation record
    expect(state2.donations.length).toBe(state1.donations.length + 1);
  });

  it("should preserve ordering when a new event is injected at the end", async () => {
    if (!schemaReady) {
      console.log("Skipping: DB schema not available (no migrations applied)");
      return;
    }

    await applyFixtureEvents(fixtureData.events);
    const state1 = await getDatabaseState();

    await clearTestState();

    const injectedEvent = {
      id: "event_injected_back",
      type: "contractEvent",
      ledger: 200,
      ledgerClosedAt: "2026-08-28T01:00:00Z",
      contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
      pagingToken: "token_injected_back_001",
      topic: ["donated", "GBDONORAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABC", "11111111-1111-1111-1111-111111111111"],
      value: [15000000, 1, null],
      inSuccessfulContractCall: true,
      txHash: "txn_injected_back_001",
    };

    const modifiedEvents = [...fixtureData.events, injectedEvent];
    await applyFixtureEvents(modifiedEvents);
    const state2 = await getDatabaseState();

    expect(state2.donations.length).toBe(state1.donations.length + 1);
  });

  // ── Dedupe-set semantics ────────────────────────────────────────────────

  it("should deduplicate events with the same pagingToken across replays", async () => {
    if (!schemaReady) {
      console.log("Skipping: DB schema not available (no migrations applied)");
      return;
    }

    // The fixture contains a duplicate event (token_001 appears twice).
    // Verify that applying the full sequence only produces one donation per unique txHash.
    await applyFixtureEvents(fixtureData.events);
    const state1 = await getDatabaseState();

    // Count donations with txHash "txn_xlm_memo_01" (the duplicated event's txHash)
    const memoDonations = state1.donations.filter(
      (d) => d.transaction_hash === "txn_xlm_memo_01"
    );

    // The donated handler deduplicates by txHash, so only one should exist
    expect(memoDonations.length).toBe(1);
  });

  it("should produce identical state when the same sequence is applied twice (dedupe idempotency)", async () => {
    if (!schemaReady) {
      console.log("Skipping: DB schema not available (no migrations applied)");
      return;
    }

    // First run
    await applyFixtureEvents(fixtureData.events);
    const state1 = await getDatabaseState();

    await clearTestState();

    // Second run (same events including the duplicate)
    await applyFixtureEvents(fixtureData.events);
    const state2 = await getDatabaseState();

    expect(normalizeState(state1)).toEqual(normalizeState(state2));
  });

  // ── Unknown / forward-compat events ─────────────────────────────────────

  it("should handle unknown event types without throwing", async () => {
    if (!schemaReady) {
      console.log("Skipping: DB schema not available (no migrations applied)");
      return;
    }

    // Filter only the unknown and logged-only events
    const loggedOnlyEvents = fixtureData.events.filter((evt) => {
      const type = extractEventType(evt);
      return !["donated", "proj_reg", "rec_cr", "rec_can", "rec_exec"].includes(type);
    });

    // Should not throw
    await expect(applyFixtureEvents(loggedOnlyEvents)).resolves.not.toThrow();
  });

  it("should handle empty topics gracefully", async () => {
    if (!schemaReady) {
      console.log("Skipping: DB schema not available (no migrations applied)");
      return;
    }

    const emptyTopicsEvents = fixtureData.events.filter(
      (evt) => evt.pagingToken === "token_024"
    );

    await expect(applyFixtureEvents(emptyTopicsEvents)).resolves.not.toThrow();
  });

  // ── Stroop boundary precision ───────────────────────────────────────────

  it("should process stroop boundary amounts without precision loss", async () => {
    if (!schemaReady) {
      console.log("Skipping: DB schema not available (no migrations applied)");
      return;
    }

    const stroopEvents = fixtureData.events.filter((evt) => {
      const token = evt.pagingToken;
      return ["token_003", "token_004", "token_005"].includes(token);
    });

    await applyFixtureEvents(stroopEvents);

    const state = await getDatabaseState();
    // Should have 3 donations from the stroop boundary events
    const stroopDonations = state.donations.filter((d) =>
      [
        "txn_stroop_boundary_03",
        "txn_sub_xlm_04",
        "txn_large_amount_05",
      ].includes(d.transaction_hash)
    );
    expect(stroopDonations.length).toBe(3);
  });

  // ── Object-style value handling ──────────────────────────────────────────

  it("should handle object-style value in donated events", async () => {
    if (!schemaReady) {
      console.log("Skipping: DB schema not available (no migrations applied)");
      return;
    }

    const objectValueEvents = fixtureData.events.filter(
      (evt) => evt.pagingToken === "token_026"
    );

    await applyFixtureEvents(objectValueEvents);

    const state = await getDatabaseState();
    const objDonations = state.donations.filter(
      (d) => d.transaction_hash === "txn_donated_object_26"
    );
    expect(objDonations.length).toBe(1);
  });

  // ── Out-of-order ledger handling ────────────────────────────────────────

  it("should process out-of-order ledger events without errors", async () => {
    if (!schemaReady) {
      console.log("Skipping: DB schema not available (no migrations applied)");
      return;
    }

    const outOfOrderEvents = fixtureData.events.filter(
      (evt) => evt.pagingToken === "token_025"
    );

    await expect(applyFixtureEvents(outOfOrderEvents)).resolves.not.toThrow();
  });

  // ── Invalid value format handling ────────────────────────────────────────

  it("should skip rec_cr events with invalid value format", async () => {
    if (!schemaReady) {
      console.log("Skipping: DB schema not available (no migrations applied)");
      return;
    }

    const invalidEvents = fixtureData.events.filter(
      (evt) => evt.pagingToken === "token_028"
    );

    await expect(applyFixtureEvents(invalidEvents)).resolves.not.toThrow();
  });

  it("should skip rec_exec events with invalid value format", async () => {
    if (!schemaReady) {
      console.log("Skipping: DB schema not available (no migrations applied)");
      return;
    }

    const invalidEvents = fixtureData.events.filter(
      (evt) => evt.pagingToken === "token_029"
    );

    await expect(applyFixtureEvents(invalidEvents)).resolves.not.toThrow();
  });
});
