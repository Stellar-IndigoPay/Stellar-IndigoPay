#!/usr/bin/env node
/**
 * backend/scripts/regenerate-fixtures.js
 *
 * Fixture-regeneration workflow for the golden-corpus event corpus.
 *
 * Modes:
 *   --derive    Derive new event shapes from the contract test suite (offline-safe)
 *   --validate  Validate existing fixtures against the schema
 *   --append    Append a single manually-crafted event (interactive)
 *   --report    Print a coverage report of event types in the corpus
 *
 * All modes update the provenance metadata (capturedAt, schemaVersion).
 * The script is offline-safe: it never requires network access.
 *
 * Usage:
 *   node scripts/regenerate-fixtures.js --validate
 *   node scripts/regenerate-fixtures.js --derive
 *   node scripts/regenerate-fixtures.js --report
 *   node scripts/regenerate-fixtures.js --append '{"topic":["donated"],"value":[10000000,1,0],...}'
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { fixtureMetadataSchema } = require("../src/schemas/sorobanEventSchema");
const { HANDLERS, extractEventType } = require("../src/services/sorobanEventService");

const FIXTURE_PATH = path.join(
  __dirname,
  "../__tests__/fixtures/events/golden-events.json",
);

const SCHEMA_VERSION = "1.0";

// ── Helpers ────────────────────────────────────────────────────────────────

function loadFixture() {
  if (!fs.existsSync(FIXTURE_PATH)) {
    return null;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
    return fixtureMetadataSchema.parse(raw);
  } catch (e) {
    console.error(`Failed to parse fixture: ${e.message}`);
    return null;
  }
}

function saveFixture(data) {
  data.provenance.capturedAt = new Date().toISOString();
  data.provenance.schemaVersion = SCHEMA_VERSION;
  fixtureMetadataSchema.parse(data); // fail loudly if broken
  fs.writeFileSync(FIXTURE_PATH, JSON.stringify(data, null, 2));
}

// ── Derived event shapes ───────────────────────────────────────────────────

/**
 * Pre-defined event shapes that cover edge cases not easily generated from
 * testnet snapshots. These are synthesized with provenance metadata and
 * validated against the schema before being added.
 *
 * Each entry is a complete event object ready to append.
 */
const DERIVED_EVENTS = [
  {
    _fixture: "Derived: XLM donation at exact stroop boundary (1 XLM)",
    id: "event_derived_stroop_exact",
    type: "contractEvent",
    ledger: 9001,
    ledgerClosedAt: "2026-08-28T00:00:00Z",
    contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
    pagingToken: "derived_stroop_exact_001",
    topic: [
      "donated",
      "GBDONORAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABC",
      "11111111-1111-1111-1111-111111111111",
    ],
    value: [10000000, 1, 0],
    inSuccessfulContractCall: true,
    txHash: "txn_derived_stroop_exact_001",
  },
  {
    _fixture: "Derived: XLM donation at sub-1 stroop boundary (0.9999999 XLM)",
    id: "event_derived_stroop_sub1",
    type: "contractEvent",
    ledger: 9002,
    ledgerClosedAt: "2026-08-28T00:00:00Z",
    contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
    pagingToken: "derived_stroop_sub1_001",
    topic: [
      "donated",
      "GBDONORAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABC",
      "11111111-1111-1111-1111-111111111111",
    ],
    value: [9999999, 0, null],
    inSuccessfulContractCall: true,
    txHash: "txn_derived_stroop_sub1_001",
  },
  {
    _fixture: "Derived: Large i128 stroop amount (1 billion stroops = 100 XLM)",
    id: "event_derived_large_i128",
    type: "contractEvent",
    ledger: 9003,
    ledgerClosedAt: "2026-08-28T00:00:00Z",
    contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
    pagingToken: "derived_large_i128_001",
    topic: [
      "donated",
      "GBDONORAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABC",
      "11111111-1111-1111-1111-111111111111",
    ],
    value: [1000000000, 3, 42],
    inSuccessfulContractCall: true,
    txHash: "txn_derived_large_i128_001",
  },
  {
    _fixture: "Derived: Unknown future event type (forward-compat test)",
    id: "event_derived_future_type",
    type: "contractEvent",
    ledger: 9004,
    ledgerClosedAt: "2026-08-28T00:00:00Z",
    contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
    pagingToken: "derived_future_type_001",
    topic: ["grantfox_v3_migration", "extra_topic"],
    value: { action: "migrate", version: 3 },
    inSuccessfulContractCall: true,
    txHash: "txn_derived_future_type_001",
  },
  {
    _fixture: "Derived: Donation with BigInt string value (edge case for i128)",
    id: "event_derived_bigint_string",
    type: "contractEvent",
    ledger: 9005,
    ledgerClosedAt: "2026-08-28T00:00:00Z",
    contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
    pagingToken: "derived_bigint_string_001",
    topic: [
      "donated",
      "GBDONORAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABC",
      "11111111-1111-1111-1111-111111111111",
    ],
    value: ["170141183460469231731687303715884105727", 3, null],
    inSuccessfulContractCall: true,
    txHash: "txn_derived_bigint_string_001",
  },
  {
    _fixture: "Derived: proj_ver with numeric project ID",
    id: "event_derived_proj_ver_numeric",
    type: "contractEvent",
    ledger: 9006,
    ledgerClosedAt: "2026-08-28T00:00:00Z",
    contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
    pagingToken: "derived_proj_ver_numeric_001",
    topic: ["proj_ver"],
    value: 42,
    inSuccessfulContractCall: true,
    txHash: "txn_derived_proj_ver_numeric_001",
  },
  {
    _fixture: "Derived: prop_new with array value",
    id: "event_derived_prop_new_array",
    type: "contractEvent",
    ledger: 9007,
    ledgerClosedAt: "2026-08-28T00:00:00Z",
    contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
    pagingToken: "derived_prop_new_array_001",
    topic: ["prop_new", "GADMINAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
    value: ["11111111-1111-1111-1111-111111111111", 10000],
    inSuccessfulContractCall: true,
    txHash: "txn_derived_prop_new_array_001",
  },
];

// ── Commands ───────────────────────────────────────────────────────────────

function cmdValidate() {
  const data = loadFixture();
  if (!data) {
    console.error("No fixture file found or fixture is invalid.");
    process.exit(1);
  }

  console.log(`✓ Fixture is valid.`);
  console.log(`  Events: ${data.events.length}`);
  console.log(`  Schema version: ${data.provenance.schemaVersion}`);
  console.log(`  Captured at: ${data.provenance.capturedAt}`);

  // Check for unique pagingTokens
  const tokens = data.events.map((e) => e.pagingToken);
  const uniqueTokens = new Set(tokens);
  if (uniqueTokens.size < tokens.length) {
    console.warn(
      `  ⚠ Duplicate pagingTokens found: ${tokens.length - uniqueTokens.size} duplicates`,
    );
  }

  // Check handler coverage
  const fixtureTypes = new Set(data.events.map((e) => extractEventType(e)));
  const registeredHandlers = Object.keys(HANDLERS).filter(
    (k) => k !== "unknown",
  );
  const covered = registeredHandlers.filter((h) => fixtureTypes.has(h));
  const uncovered = registeredHandlers.filter((h) => !fixtureTypes.has(h));

  console.log(`  Handler coverage: ${covered.length}/${registeredHandlers.length}`);
  if (uncovered.length > 0) {
    console.warn(`  ⚠ Uncovered handlers: ${uncovered.join(", ")}`);
  }
}

function cmdDerive() {
  let data = loadFixture();
  if (!data) {
    data = {
      provenance: {
        sourceTxHash: "derived_genesis",
        capturedAt: new Date().toISOString(),
        schemaVersion: SCHEMA_VERSION,
        description: "Golden fixture corpus for the Soroban event pipeline.",
        tags: ["replay-determinism", "coverage", "edge-cases"],
      },
      events: [],
    };
  }

  const existingTokens = new Set(data.events.map((e) => e.pagingToken));
  let added = 0;

  for (const event of DERIVED_EVENTS) {
    if (!existingTokens.has(event.pagingToken)) {
      data.events.push(event);
      existingTokens.add(event.pagingToken);
      added++;
      console.log(`  + Added: ${event._fixture || event.id}`);
    } else {
      console.log(`  = Skipped (already exists): ${event._fixture || event.id}`);
    }
  }

  saveFixture(data);
  console.log(`\nDerivation complete: ${added} new events added, ${data.events.length} total.`);
}

function cmdAppend(eventJson) {
  let event;
  try {
    event = JSON.parse(eventJson);
  } catch {
    console.error("Invalid JSON provided for --append.");
    process.exit(1);
  }

  // Ensure required fields
  if (!event.pagingToken) {
    event.pagingToken = `appended_${Date.now()}`;
  }
  if (!event.id) {
    event.id = `event_appended_${Date.now()}`;
  }
  if (!event.type) {
    event.type = "contractEvent";
  }
  if (!event.contractId) {
    event.contractId =
      "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
  }

  let data = loadFixture();
  if (!data) {
    data = {
      provenance: {
        sourceTxHash: "manual_append",
        capturedAt: new Date().toISOString(),
        schemaVersion: SCHEMA_VERSION,
      },
      events: [],
    };
  }

  data.events.push(event);
  saveFixture(data);
  console.log(
    `Appended event with pagingToken=${event.pagingToken}. Total: ${data.events.length}.`,
  );
}

function cmdReport() {
  const data = loadFixture();
  if (!data) {
    console.error("No valid fixture found.");
    process.exit(1);
  }

  // Count event types
  const typeCounts = {};
  for (const evt of data.events) {
    const type = extractEventType(evt);
    typeCounts[type] = (typeCounts[type] || 0) + 1;
  }

  // Handler coverage
  const registeredHandlers = Object.keys(HANDLERS).filter(
    (k) => k !== "unknown",
  );

  console.log("=== Golden Corpus Coverage Report ===\n");
  console.log(`Total events: ${data.events.length}`);
  console.log(`Schema version: ${data.provenance.schemaVersion}`);
  console.log(`Last captured: ${data.provenance.capturedAt}\n`);

  console.log("Event type distribution:");
  for (const [type, count] of Object.entries(typeCounts).sort(
    (a, b) => b[1] - a[1],
  )) {
    const isRegistered = HANDLERS[type] !== undefined;
    const marker = isRegistered ? "✓" : "○";
    console.log(`  ${marker} ${type}: ${count}`);
  }

  console.log("\nHandler coverage:");
  for (const handler of registeredHandlers) {
    const count = typeCounts[handler] || 0;
    const marker = count > 0 ? "✓" : "✗";
    console.log(`  ${marker} ${handler}: ${count} event(s)`);
  }

  const uncovered = registeredHandlers.filter((h) => !typeCounts[h]);
  if (uncovered.length > 0) {
    console.log(`\n⚠ Uncovered handlers (${uncovered.length}): ${uncovered.join(", ")}`);
  } else {
    console.log("\n✓ All registered handlers are covered by the corpus.");
  }

  // Edge-case coverage
  console.log("\nEdge-case coverage:");
  const hasDuplicate = data.events.some(
    (e, i) =>
      data.events.findIndex((e2) => e2.pagingToken === e.pagingToken) !== i,
  );
  const hasEmptyTopics = data.events.some(
    (e) => Array.isArray(e.topic) && e.topic.length === 0,
  );
  const hasUnknownType = data.events.some(
    (e) => !HANDLERS[extractEventType(e)],
  );
  const hasObjectValue = data.events.some(
    (e) =>
      e.value && typeof e.value === "object" && !Array.isArray(e.value),
  );

  console.log(`  ${hasDuplicate ? "✓" : "✗"} Duplicate events (dedupe test)`);
  console.log(`  ${hasEmptyTopics ? "✓" : "✗"} Empty topics (forward-compat)`);
  console.log(`  ${hasUnknownType ? "✓" : "✗"} Unknown event types`);
  console.log(`  ${hasObjectValue ? "✓" : "✗"} Object-style values`);
}

// ── CLI ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case "--validate":
    cmdValidate();
    break;
  case "--derive":
    cmdDerive();
    break;
  case "--append":
    if (!args[1]) {
      console.error("Usage: node regenerate-fixtures.js --append '<event-json>'");
      process.exit(1);
    }
    cmdAppend(args[1]);
    break;
  case "--report":
    cmdReport();
    break;
  default:
    console.log(`
Usage: node scripts/regenerate-fixtures.js <command>

Commands:
  --validate   Validate existing fixtures against the schema
  --derive     Derive new event shapes from the contract test suite
  --append     Append a manually-crafted event (JSON string)
  --report     Print a coverage report of event types in the corpus
    `);
    break;
}
