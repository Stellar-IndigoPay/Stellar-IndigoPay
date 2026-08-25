"use strict";

/**
 * backend/test/properties/merkleTree.properties.test.js
 *
 * Property-based tests for Merkle proof soundness and tree invariants over
 * randomized leaf sets (including odd counts, delimiter-heavy and unicode
 * field values). Exercises the production buildMerkleTree /
 * generateMerkleProof / verifyMerkleProof only.
 *
 * Failures print the seed; replay with:
 *   PROPERTY_SEED=<base> npx jest test/properties
 */

const {
  buildMerkleTree,
  generateMerkleProof,
  verifyMerkleProof,
} = require("../../src/services/merkleTree");
const { checkProperty } = require("./harness/property");
const {
  flipBit,
  merkleDeterminismProperty,
  merkleProofSoundnessProperty,
} = require("./harness/soundness");
const { resolveIterations, suiteSeed } = require("./harness/rng");
const { hexText, isoTimestamp, text } = require("./harness/generators");

const SEED = suiteSeed(2);
const half = () => Math.max(1, Math.floor(resolveIterations() / 2));

/** Random audit-style entry set with distinct ids (size bounded for CI). */
function genEntrySet(rng) {
  const count = rng.int(1, 64);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    entries.push({
      id: `entry-${i}`,
      prevHash: hexText(rng, 64),
      action: text(rng, 0, 24),
      actor: text(rng, 1, 16),
      resource: text(rng, 0, 30),
      timestamp: isoTimestamp(rng),
    });
  }
  return entries;
}

describe("merkle tree properties", () => {
  test("property: sampled proof is sound; any single-bit tamper of leaf or siblings fails", async () => {
    await checkProperty({
      name: "merkle proof soundness",
      seed: SEED + 11,
      iterations: half(),
      gen: (rng) => ({
        entries: genEntrySet(rng),
        leafByte: rng.int(0, 255),
        leafBit: rng.int(0, 7),
        stepIndex: rng.int(0, 15),
        stepByte: rng.int(0, 255),
        stepBit: rng.int(0, 7),
      }),
      predicate: async (input) => {
        // Soundness holds for EVERY leaf index of each generated tree.
        for (let leafIndex = 0; leafIndex < input.entries.length; leafIndex += 1) {
          /* eslint-disable-next-line no-await-in-loop -- sequential invariant checks */
          await merkleProofSoundnessProperty({
            ...input,
            leafIndex,
            stepIndex: (input.stepIndex + leafIndex) % (input.entries.length || 1),
          });
        }
      },
    });
  });

  test("property: every leaf of every random tree has a verifiable inclusion proof", async () => {
    await checkProperty({
      name: "merkle all-leaves verifiable",
      seed: SEED + 33,
      iterations: half(),
      gen: genEntrySet,
      predicate: async (entries) => {
        const { root, tree, leafCount } = buildMerkleTree(entries);
        if (!verifyMerkleProof(tree[0][0], generateMerkleProof(tree, 0).proof, root, leafCount)) {
          throw new Error(`root proof rejected for ${leafCount}-leaf tree`);
        }
        for (let i = 0; i < entries.length; i += 1) {
          const { leaf, proof } = generateMerkleProof(tree, i);
          if (!verifyMerkleProof(leaf, proof, root, leafCount)) {
            throw new Error(`valid proof for leaf ${i} rejected`);
          }
          const tamperedLeaf = flipBit(leaf, i % 32, i % 8);
          if (verifyMerkleProof(tamperedLeaf, proof, root, leafCount)) {
            throw new Error(`tampered leaf ${i} accepted`);
          }
        }
      },
    });
  });

  test("property: trees are deterministic; permutations and odd-leaf duplication change the root", async () => {
    await checkProperty({
      name: "merkle tree determinism",
      seed: SEED + 22,
      iterations: half(),
      gen: (rng) => {
        const entries = genEntrySet(rng);
        return { entries, permutation: rng.shuffle(entries.map((_, i) => i)) };
      },
      predicate: merkleDeterminismProperty,
    });
  });
});
