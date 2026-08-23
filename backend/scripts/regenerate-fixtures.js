"use strict";

const fs = require("fs");
const path = require("path");
const { fixtureMetadataSchema } = require("../src/schemas/sorobanEventSchema");

const fixturePath = path.join(__dirname, "../__tests__/fixtures/events/golden-events.json");

/**
 * Regenerates or appends golden events into the fixtures corpus.
 * Normally this would fetch from testnet or Horizon, but for
 * the regeneration workflow, it manages the JSON structure.
 */
async function regenerateFixtures() {
  console.log("Regenerating fixtures...");
  
  let existingData = {
    provenance: {
      sourceTxHash: "mock_genesis",
      capturedAt: new Date().toISOString(),
      schemaVersion: "1.0"
    },
    events: []
  };

  if (fs.existsSync(fixturePath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
      existingData = fixtureMetadataSchema.parse(raw);
      console.log(`Loaded ${existingData.events.length} existing events.`);
    } catch (e) {
      console.warn("Could not parse existing fixture, creating new one.", e.message);
    }
  }

  // Example of adding a new event shape deliberately
  const newEvent = {
    id: `event_generated_${Date.now()}`,
    type: "contractEvent",
    ledger: 102,
    ledgerClosedAt: new Date().toISOString(),
    contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
    pagingToken: `token_${Date.now()}`,
    topic: ["donated", "GBDONORAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABC", "11111111-1111-1111-1111-111111111111"],
    value: [5000000, 1, 12345],
    inSuccessfulContractCall: true,
    txHash: `txn_${Date.now()}`
  };

  existingData.events.push(newEvent);
  existingData.provenance.capturedAt = new Date().toISOString();

  // Validate before writing to fail loudly if broken
  fixtureMetadataSchema.parse(existingData);

  fs.writeFileSync(fixturePath, JSON.stringify(existingData, null, 2));
  console.log(`Successfully wrote ${existingData.events.length} events to ${fixturePath}`);
}

regenerateFixtures().catch(console.error);
