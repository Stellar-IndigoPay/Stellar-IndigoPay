"use strict";

const fs = require("fs");
const path = require("path");
const pool = require("../../src/db/pool");
const { fixtureMetadataSchema } = require("../../src/schemas/sorobanEventSchema");
const { HANDLERS, extractEventType, extractTopics, extractValue } = require("../../src/services/sorobanEventService");
const { v4: uuid } = require("uuid");

const fixturePath = path.join(__dirname, "../fixtures/events/golden-events.json");

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
    const client = await pool.connect();
    try {
      schemaReady = await tableExists(client, "projects")
        && await tableExists(client, "donations")
        && await tableExists(client, "profiles");
    } finally {
      client.release();
    }
  });

  beforeEach(async () => {
    if (!schemaReady) return;

    // Clear state before each run
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      
      if (await tableExists(client, "soroban_event_dlq")) {
        await client.query("DELETE FROM soroban_event_dlq");
      }
      
      if (await tableExists(client, "indexer_state")) {
        await client.query("DELETE FROM indexer_state");
      }
      if (await tableExists(client, "donations")) {
        await client.query("DELETE FROM donations WHERE project_id = $1", ["11111111-1111-1111-1111-111111111111"]);
      }
      if (await tableExists(client, "projects")) {
        await client.query("DELETE FROM projects WHERE id = $1", ["11111111-1111-1111-1111-111111111111"]);
      }
      if (await tableExists(client, "profiles")) {
        await client.query("DELETE FROM profiles WHERE public_key = $1", ["GBDONORAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABC"]);
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  });

  async function applyFixtureEvents(events) {
    for (const evt of events) {
      const eventType = extractEventType(evt);
      const topics = extractTopics(evt);
      const value = extractValue(evt);

      if (HANDLERS[eventType]) {
        // Ensure the parent project row exists before a donated event to
        // satisfy the foreign-key constraint.
        if (eventType === "donated") {
          const projectId = topics[2];
          await pool.query(
            "INSERT INTO projects (id, name, description, category, location, wallet_address, raised_xlm) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING",
            [projectId, "Test Project", "Fixture project", "other", "unknown", "GCREATOR", 0]
          );
        }

        await HANDLERS[eventType](evt, topics, value);
      }
    }
  }

  // Columns that change between runs due to uuid() and NOW() defaults.
  const NON_DETERMINISTIC_KEYS = new Set([
    "id", "created_at", "updated_at", "search_vector",
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
    if (await tableExists(pool, "soroban_event_dlq")) {
      await pool.query("DELETE FROM soroban_event_dlq");
    }
    if (await tableExists(pool, "indexer_state")) {
      await pool.query("DELETE FROM indexer_state");
    }
    if (await tableExists(pool, "donations")) {
      await pool.query("DELETE FROM donations WHERE project_id = $1", ["11111111-1111-1111-1111-111111111111"]);
    }
    if (await tableExists(pool, "projects")) {
      await pool.query("DELETE FROM projects WHERE id = $1", ["11111111-1111-1111-1111-111111111111"]);
    }
    if (await tableExists(pool, "profiles")) {
      await pool.query("DELETE FROM profiles WHERE public_key = $1", ["GBDONORAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABC"]);
    }
  }

  it("should process the fixture sequence deterministically", async () => {
    if (!schemaReady) {
      // eslint-disable-next-line no-console
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

    // Compare deterministic fields only (UUIDs and timestamps differ between runs)
    expect(normalizeState(state1)).toEqual(normalizeState(state2));

    // Verify it processed correctly
    expect(state1.donations.length).toBeGreaterThan(0);
  });

  it("should detect drift if a fixture is mutated", async () => {
    if (!schemaReady) {
      // eslint-disable-next-line no-console
      console.log("Skipping: DB schema not available (no migrations applied)");
      return;
    }

    await applyFixtureEvents(fixtureData.events);
    const state1 = await getDatabaseState();

    // Clear state
    await clearTestState();

    // Mutate fixture slightly
    const mutatedEvents = JSON.parse(JSON.stringify(fixtureData.events));
    if (mutatedEvents[0].value && Array.isArray(mutatedEvents[0].value)) {
      mutatedEvents[0].value[0] = 20000000; // mutate amount
    }

    await applyFixtureEvents(mutatedEvents);
    const state2 = await getDatabaseState();

    expect(normalizeState(state1)).not.toEqual(normalizeState(state2));
  });
});
