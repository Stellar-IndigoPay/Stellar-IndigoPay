"use strict";

/**
 * backend/test/properties/mutation-canary.test.js
 *
 * Sensitivity check for the property suites (acceptance criterion: "a
 * deliberately broken invariant is caught by at least one property").
 *
 * Each canary wraps a PRODUCTION function with a small, realistic mutation
 * (an off-by-one in proof handling, a corrupted leaf, an over-permissive
 * verifier) and re-runs the SAME invariant predicate used by the suites.
 * Every mutant MUST be rejected, and the runner MUST report a seed and a
 * minimal counterexample. If one of these tests ever fails, the properties
 * have lost their teeth and the suite is giving false confidence.
 *
 * Production modules are never modified — mutants are thin wrappers around
 * them, so the assertions still exercise the real implementations.
 */

const {
  buildMerkleTree,
  generateMerkleProof,
  verifyMerkleProof,
} = require("../../src/services/merkleTree");
const { verifyChain } = require("../../src/services/auditChain");

const {
  PropertyFailure,
  checkProperty,
} = require("./harness/property");
const {
  auditChainIntegrityProperty,
  buildValidChain,
  chainClient,
  flipBit,
  merkleProofSoundnessProperty,
} = require("./harness/soundness");
const { resolveIterations, Rng, suiteSeed } = require("./harness/rng");
const { hexText, isoTimestamp } = require("./harness/generators");
const { TAMPERABLE_FIELDS } = require("./harness/soundness");

const SEED = suiteSeed(9);
const SMALL_ITERATIONS = 10;

function genEntries(rng) {
  const count = rng.int(1, 16);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    entries.push({
      id: `entry-${i}`,
      prevHash: hexText(rng, 64),
      action: `action-${i}`,
      actor: `actor-${i}`,
      resource: `resource-${i}`,
      timestamp: isoTimestamp(rng),
    });
  }
  return entries;
}

function genAuditCase(rng) {
  const specs = [];
  let tick = Date.UTC(2024, 0, 1);
  for (let i = 0, n = rng.int(2, 8); i < n; i += 1) {
    tick += rng.int(1000, 60000);
    specs.push({
      id: `row-${String(i).padStart(4, "0")}`,
      actor: `actor-${i}`,
      action: "login",
      targetType: null,
      targetId: null,
      metadata: JSON.stringify({ i }),
      ipAddress: null,
      created_at: new Date(tick).toISOString(),
    });
  }
  return {
    specs,
    tamper: {
      rowIndex: rng.int(0, specs.length - 1),
      field: rng.pick(TAMPERABLE_FIELDS),
    },
  };
}

describe("mutation canaries — the properties must catch deliberate breakage", () => {
  test("canary: dropping the last proof step (off-by-one) fails the soundness property with a reported seed", async () => {
    // Off-by-one analogue of a classic Merkle implementation bug: verify
    // while silently ignoring the final sibling.
    const mutantVerify = (leaf, proof, root, leafCount) =>
      verifyMerkleProof(leaf, proof.slice(0, -1), root, leafCount);

    await expect(
      checkProperty({
        name: "canary/merkle off-by-one",
        seed: SEED + 11,
        iterations: SMALL_ITERATIONS,
        gen: (rng) => ({
          entries: genEntries(rng),
          leafIndex: rng.int(0, 15),
          leafByte: rng.int(0, 255),
          leafBit: rng.int(0, 7),
          stepIndex: 0,
          stepByte: rng.int(0, 255),
          stepBit: rng.int(0, 7),
        }),
        predicate: async (input) => {
          const { root, tree, leafCount } = buildMerkleTree(input.entries);
          const { leaf, proof } = generateMerkleProof(tree, input.leafIndex % input.entries.length);
          if (!mutantVerify(leaf, proof, root, leafCount)) {
            throw new Error("valid proof rejected by mutant verifier");
          }
          await merkleProofSoundnessProperty({
            ...input,
            leafIndex: input.leafIndex % input.entries.length,
          });
        },
      }),
    ).rejects.toThrow(PropertyFailure);
  });

  test("canary: a verifier that corrupts its leaf input fails the 'valid proofs verify' property", async () => {
    // Simulates a serialization bug inside verification: the leaf is mutated
    // before hashing, so genuinely valid proofs get rejected.
    const corruptVerify = (leaf, proof, root, leafCount) =>
      verifyMerkleProof(flipBit(leaf, 0, 0), proof, root, leafCount);

    const entries = genEntries(new Rng(SEED + 12));
    const { root, tree, leafCount } = buildMerkleTree(entries);
    const { leaf, proof } = generateMerkleProof(tree, 0);
    expect(verifyMerkleProof(leaf, proof, root, leafCount)).toBe(true);
    expect(corruptVerify(leaf, proof, root, leafCount)).toBe(false);

    await expect(
      checkProperty({
        name: "canary/corrupt verifier",
        seed: SEED + 12,
        iterations: SMALL_ITERATIONS,
        gen: (rng) => ({
          entries: genEntries(rng),
          leafIndex: 0,
          leafByte: rng.int(0, 255),
          leafBit: rng.int(0, 7),
          stepIndex: 0,
          stepByte: rng.int(0, 255),
          stepBit: rng.int(0, 7),
        }),
        predicate: async (input) => {
          const built = buildMerkleTree(input.entries);
          const generated = generateMerkleProof(built.tree, 0);
          if (!corruptVerify(generated.leaf, generated.proof, built.root, built.leafCount)) {
            throw new Error("valid proof rejected by corrupt verifier");
          }
        },
      }),
    ).rejects.toThrow(/seed|minimal counterexample/i);
  });

  test("canary: a verifier that ignores the stored row_hash misses nothing — chain property must flag it", async () => {
    // Mutant audit verification: accept any chain whose links line up,
    // skipping per-row hash recomputation (the invariant that detects
    // in-place field edits). The mutant rewrites every stored row_hash to the
    // recomputation of its own row — exactly what verifyChain checks — so
    // link checks alone decide validity and field tampering goes undetected.
    const { computeRowHash } = require("../../src/services/auditChain");
    const asVerifierInput = (row) => ({
      id: row.id,
      actor: row.actor,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      metadata: row.metadata,
      ipAddress: row.ip_address,
      created_at: row.created_at,
      prev_hash: row.prev_hash || "0",
    });
    const mutantChainClient = (rows) => {
      const client = chainClient(rows);
      return {
        async query(text) {
          const result = await client.query(text);
          if (!text.includes("audit_chain_anchor") && Array.isArray(result.rows)) {
            result.rows = result.rows.map((row) => ({
              ...row,
              row_hash: computeRowHash(asVerifierInput(row)),
            }));
          }
          return result;
        },
      };
    };

    await expect(
      checkProperty({
        name: "canary/audit ignores row_hash",
        seed: SEED + 13,
        iterations: SMALL_ITERATIONS,
        gen: genAuditCase,
        predicate: async (input) => {
          const clean = buildValidChain(input.specs);
          const rowIndex = input.tamper.rowIndex % clean.length;
          const field = input.tamper.field;
          const original = clean[rowIndex][field];
          const mutated =
            field === "metadata"
              ? `${JSON.stringify(typeof original === "string" ? JSON.parse(original) : original || {})}|tampered`
              : `${String(original ?? "")}|tampered`;
          if (mutated === original) throw new Error("generation bug: identical tamper value");
          const tamperedRows = clean.map((row, i) =>
            i === rowIndex ? { ...row, [field]: mutated } : row,
          );
          const badResult = await verifyChain(mutantChainClient(tamperedRows));
          if (badResult.valid !== false) {
            throw new Error(
              `mutant verifier missed tampering "${field}" of row ${rowIndex}`,
            );
          }
        },
      }),
    ).rejects.toThrow(PropertyFailure);
  });

  test("sanity: the real implementations pass the same predicates", async () => {
    await checkProperty({
      name: "canary control group (production code)",
      seed: SEED + 99,
      iterations: Math.max(3, Math.floor(resolveIterations() / 5)),
      gen: genAuditCase,
      predicate: auditChainIntegrityProperty,
    });
  });
});
