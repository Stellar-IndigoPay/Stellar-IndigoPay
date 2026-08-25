"use strict";

/**
 * backend/test/properties/auditChain.properties.test.js
 *
 * Property-based tests for audit-chain integrity: append/verify round-trips,
 * tamper detection at the exact tampered row, canonicalization injectivity
 * (regression net for the pipe-delimiter collision class), documented
 * normalization equivalences, and determinism of chain state from the entry
 * sequence. Exercises the production computeRowHash / canonicalize /
 * verifyChain only.
 *
 * Failures print the seed; replay with:
 *   PROPERTY_SEED=<base> npx jest test/properties
 */

const {
  buildValidChain,
  chainClient,
} = require("./harness/soundness");
const { GENESIS_PREV_HASH, verifyChain } = require("../../src/services/auditChain");
const { checkProperty } = require("./harness/property");
const {
  TAMPERABLE_FIELDS,
  auditChainDeterminismProperty,
  auditChainIntegrityProperty,
  auditNormalizationEquivalenceProperty,
  canonicalizationInjectivityProperty,
} = require("./harness/soundness");
const { resolveIterations, suiteSeed } = require("./harness/rng");
const { hexText, isoTimestamp, text } = require("./harness/generators");

const SEED = suiteSeed(3);
const iterations = () => resolveIterations();
const half = () => Math.max(1, Math.floor(resolveIterations() / 2));

// Strictly increasing timestamps keep the SQL row order identical to append
// order regardless of id collation.
function genSpecs(rng) {
  const count = rng.int(1, 50);
  const specs = [];
  let tick = Date.UTC(2024, 0, 1);
  for (let i = 0; i < count; i += 1) {
    tick += rng.int(1000, 60000);
    specs.push({
      id: `row-${String(i).padStart(4, "0")}`,
      actor: text(rng, 1, 12),
      action: text(rng, 1, 16),
      targetType: rng.chance(0.7) ? text(rng, 0, 10) : null,
      targetId: rng.chance(0.7) ? text(rng, 0, 12) : null,
      metadata: rng.chance(0.5)
        ? JSON.stringify({ op: text(rng, 0, 8), pipe: text(rng, 0, 6) })
        : null,
      ipAddress: rng.chance(0.6)
        ? `${rng.int(1, 255)}.${rng.int(0, 255)}.${rng.int(0, 255)}.${rng.int(1, 254)}`
        : null,
      created_at: new Date(tick).toISOString(),
    });
  }
  return specs;
}

describe("audit chain properties", () => {
  test("property: appending N entries verifies; tampering ANY field of ANY row is detected at that row", async () => {
    await checkProperty({
      name: "audit chain integrity",
      seed: SEED + 11,
      iterations: half(),
      gen: (rng) => ({
        specs: genSpecs(rng),
        tamper: {
          rowIndex: rng.int(0, 49),
          // metadata is included via TAMPERABLE_FIELDS below
          field: rng.pick(TAMPERABLE_FIELDS),
        },
      }),
      predicate: auditChainIntegrityProperty,
    });
  });

  test("property: prev_hash tampering of any link breaks verification at that link", async () => {
    await checkProperty({
      name: "audit chain link tamper detection",
      seed: SEED + 22,
      iterations: half(),
      gen: (rng) => ({
        specs: genSpecs(rng),
        tamper: { rowIndex: rng.int(0, 49), field: "prev_hash" },
      }),
      predicate: async (input) => {
        const rows = buildValidChain(input.specs);
        const rowIndex = input.tamper.rowIndex % rows.length;
        // Replace the stored prev_hash with a guaranteed-different value.
        const replacement =
          rows[rowIndex].prev_hash === GENESIS_PREV_HASH
            ? "f".repeat(64)
            : GENESIS_PREV_HASH;
        if (replacement === rows[rowIndex].prev_hash) return; // unreachable by construction
        const tampered = rows.map((row, i) =>
          i === rowIndex ? { ...row, prev_hash: replacement } : row,
        );
        const result = await verifyChain(chainClient(tampered));
        if (result.valid !== false) {
          throw new Error(`prev_hash tampering of row ${rowIndex} was NOT detected`);
        }
        if (result.firstInvalidId !== tampered[rowIndex].id) {
          throw new Error(
            `firstInvalidId ${result.firstInvalidId} != tampered link row ${tampered[rowIndex].id}`,
          );
        }
      },
    });
  });

  test("property: canonicalization is injective across the pipe-collision class", async () => {
    await checkProperty({
      name: "canonicalization injectivity",
      seed: SEED + 33,
      iterations: iterations(),
      gen: (rng) => ({
        fields: [
          `id-${hexText(rng, 6)}`,
          text(rng, 1, 10),
          text(rng, 1, 10),
          text(rng, 1, 8),
          text(rng, 1, 8),
          text(rng, 1, 12),
          text(rng, 1, 15),
          isoTimestamp(rng),
          hexText(rng, 64),
        ],
        mutateIndex: rng.int(0, 8),
        mode: rng.pick(["pipeShift", "append", "swapChars"]),
        pipeSegment: rng.pick(["|", "||", "|x|"]),
      }),
      predicate: canonicalizationInjectivityProperty,
    });
  });

  test("property: documented normalizations hold for arbitrary inputs", async () => {
    await checkProperty({
      name: "canonicalization normalization equivalences",
      seed: SEED + 44,
      iterations: half(),
      gen: (rng) => ({
        fields: [
          `id-${hexText(rng, 6)}`,
          text(rng, 1, 10),
          text(rng, 1, 10),
          text(rng, 0, 8),
          text(rng, 0, 8),
          text(rng, 0, 12),
          text(rng, 0, 15),
          isoTimestamp(rng),
          hexText(rng, 64),
        ],
        nullableField: rng.pick(["targetType", "targetId", "ipAddress", "metadata"]),
        metadataObject: {
          a: text(rng, 0, 8),
          b: rng.int(0, 9999).toString(),
          c: text(rng, 0, 6),
        },
        dateMs: Date.UTC(2020, 0, 1) + rng.int(0, 10 * 365 * 24 * 3600 * 1000),
      }),
      predicate: auditNormalizationEquivalenceProperty,
    });
  });

  test("property: chain state is deterministic from the entry sequence", async () => {
    await checkProperty({
      name: "audit chain determinism",
      seed: SEED + 55,
      iterations: half(),
      gen: (rng) => ({
        specs: genSpecs(rng),
        mutateIndex: rng.int(0, 49),
        mutateDelta: hexText(rng, 4),
      }),
      predicate: auditChainDeterminismProperty,
    });
  });
});
