"use strict";

const {
  buildMerkleTree,
  buildMerkleTreeStreaming,
  buildMerkleTreeStreamingWithProof,
  generateMerkleProof,
  verifyMerkleProof,
} = require("../services/merkleTree");

/**
 * Deterministic audit-style entry fixture.
 * @param {number} n
 * @returns {{id: string, prevHash: string, action: string, actor: string, resource: string, timestamp: string}}
 */
function entry(n) {
  return {
    id: String(n),
    prevHash: `prev-${n}`,
    action: `action-${n}`,
    actor: `actor-${n}`,
    resource: `resource-${n}`,
    timestamp: `2026-08-${String(10 + n).padStart(2, "0")}T00:00:00.000Z`,
  };
}

describe("merkleTree.buildMerkleTree", () => {
  it("returns a root, tree levels, leafCount and height", () => {
    const { root, tree, leafCount, height } = buildMerkleTree([entry(1), entry(2)]);
    expect(Buffer.isBuffer(root)).toBe(true);
    expect(root.length).toBe(32);
    expect(Array.isArray(tree)).toBe(true);
    expect(tree.length).toBe(height + 1);
    expect(leafCount).toBe(2);
    expect(height).toBe(1);
  });

  it("is deterministic for identical inputs", () => {
    const a = buildMerkleTree([entry(1), entry(2), entry(3)]);
    const b = buildMerkleTree([entry(1), entry(2), entry(3)]);
    expect(a.root.equals(b.root)).toBe(true);
  });

  it("changes the root when any field changes", () => {
    const a = buildMerkleTree([entry(1), entry(2)]);
    const b = buildMerkleTree([entry(1), { ...entry(2), actor: "attacker" }]);
    expect(a.root.equals(b.root)).toBe(false);
  });

  it("binds the leaf count so [A, B, C] and [A, B, C, C] differ", () => {
    const three = buildMerkleTree([entry(1), entry(2), entry(3)]);
    const four = buildMerkleTree([entry(1), entry(2), entry(3), entry(3)]);
    expect(three.root.equals(four.root)).toBe(false);
  });

  it("rejects an empty entry list", () => {
    expect(() => buildMerkleTree([])).toThrow(/without entries/);
  });
});

describe("merkleTree.generateMerkleProof", () => {
  it.each([1, 2, 3, 4, 5, 8])(
    "produces a valid proof for every leaf of a %i-leaf tree",
    (count) => {
      const entries = Array.from({ length: count }, (_, i) => entry(i + 1));
      const { root, tree, leafCount } = buildMerkleTree(entries);
      for (let i = 0; i < count; i += 1) {
        const { leaf, proof } = generateMerkleProof(tree, i);
        expect(verifyMerkleProof(leaf, proof, root, leafCount)).toBe(true);
      }
    },
  );

  it("rejects an out-of-bounds leaf index", () => {
    const { tree } = buildMerkleTree([entry(1), entry(2)]);
    expect(() => generateMerkleProof(tree, 2)).toThrow(/out of bounds/);
  });

  it("rejects a negative leaf index", () => {
    const { tree } = buildMerkleTree([entry(1), entry(2)]);
    expect(() => generateMerkleProof(tree, -1)).toThrow(/out of bounds/);
  });
});

describe("merkleTree.verifyMerkleProof", () => {
  it("rejects a tampered leaf", () => {
    const entries = [entry(1), entry(2), entry(3)];
    const { root, tree, leafCount } = buildMerkleTree(entries);
    const { proof } = generateMerkleProof(tree, 0);
    const wrongLeaf = buildMerkleTree([entry(99)]);
    expect(verifyMerkleProof(wrongLeaf.tree[0][0], proof, root, leafCount)).toBe(false);
  });

  it("rejects a proof with the wrong leaf count (height/shape binding)", () => {
    const { root, tree } = buildMerkleTree([entry(1), entry(2), entry(3)]);
    const { leaf, proof } = generateMerkleProof(tree, 2);
    expect(verifyMerkleProof(leaf, proof, root, 3)).toBe(true);
    expect(verifyMerkleProof(leaf, proof, root, 4)).toBe(false);
  });

  it("rejects a truncated proof", () => {
    const { root, tree } = buildMerkleTree([entry(1), entry(2), entry(3), entry(4)]);
    const { leaf, proof } = generateMerkleProof(tree, 0);
    expect(verifyMerkleProof(leaf, proof.slice(0, 1), root, 4)).toBe(false);
  });

  it("rejects a second-preimage forgery (internal node passed as a leaf)", () => {
    const { tree, root } = buildMerkleTree([entry(1), entry(2), entry(3)]);

    // tree[1][0] is the internal node hash of leaves 0 and 1. An attacker
    // presents it as a "leaf" of a two-leaf tree whose sibling is tree[1][1].
    // Without domain separation this computed the same raw root; without the
    // committed leaf count it would also verify. Both defenses must reject it.
    const forgedLeaf = tree[1][0];
    const forgedProof = [{ position: "right", hash: tree[1][1] }];

    expect(verifyMerkleProof(forgedLeaf, forgedProof, root, 2)).toBe(false);
  });

  it("returns false for a malformed proof step", () => {
    const { root } = buildMerkleTree([entry(1), entry(2)]);
    const leaf = buildMerkleTree([entry(1)]).tree[0][0];
    expect(verifyMerkleProof(leaf, [{ position: "up", hash: Buffer.alloc(32) }], root, 2)).toBe(false);
  });

  it("returns false for an invalid leaf count", () => {
    const { root, tree } = buildMerkleTree([entry(1), entry(2)]);
    const { leaf, proof } = generateMerkleProof(tree, 0);
    expect(verifyMerkleProof(leaf, proof, root, 0)).toBe(false);
    expect(verifyMerkleProof(leaf, proof, root, 2.5)).toBe(false);
  });
});

describe("merkleTree.buildMerkleTreeStreaming", () => {
  async function* entries(n) {
    for (let i = 1; i <= n; i += 1) {
      yield entry(i);
    }
  }

  it("produces the same root as buildMerkleTree for the same inputs", async () => {
    for (const n of [1, 2, 3, 4, 5, 8, 13]) {
      const regular = buildMerkleTree(Array.from({ length: n }, (_, i) => entry(i + 1)));
      const streaming = await buildMerkleTreeStreaming(entries(n));
      expect(streaming.root.equals(regular.root)).toBe(true);
      expect(streaming.leafCount).toBe(n);
      expect(streaming.height).toBe(regular.height);
    }
  });

  it("rejects an empty iterator", async () => {
    await expect(buildMerkleTreeStreaming(entries(0))).rejects.toThrow(/without entries/);
  });

  it("builds a 100,000-entry tree without exceeding 256 MB heap", async () => {
    const before = process.memoryUsage().heapUsed;
    const result = await buildMerkleTreeStreaming(entries(100000));
    const after = process.memoryUsage().heapUsed;
    expect(result.leafCount).toBe(100000);
    expect(Buffer.isBuffer(result.root)).toBe(true);
    // Allow generous slack for the test runner itself; the tree build itself
    // should stay well under 256 MB.
    expect(after - before).toBeLessThan(256 * 1024 * 1024);
  });
});

describe("merkleTree.buildMerkleTreeStreamingWithProof", () => {
  async function* entries(n) {
    for (let i = 1; i <= n; i += 1) {
      yield entry(i);
    }
  }

  it.each([1, 2, 3, 4, 5, 8, 13])(
    "produces proofs matching buildMerkleTree + generateMerkleProof for a %i-leaf tree",
    async (count) => {
      const regularEntries = Array.from({ length: count }, (_, i) => entry(i + 1));
      const regular = buildMerkleTree(regularEntries);
      for (let i = 0; i < count; i += 1) {
        const regularProof = generateMerkleProof(regular.tree, i);
        const streaming = await buildMerkleTreeStreamingWithProof(entries(count), i);

        expect(streaming.root.equals(regular.root)).toBe(true);
        expect(streaming.leaf.equals(regularProof.leaf)).toBe(true);
        expect(streaming.proof.length).toBe(regularProof.proof.length);
        for (let p = 0; p < streaming.proof.length; p += 1) {
          expect(streaming.proof[p].position).toBe(regularProof.proof[p].position);
          expect(streaming.proof[p].hash.equals(regularProof.proof[p].hash)).toBe(true);
        }
        // The streaming proof must verify against the regular root.
        expect(verifyMerkleProof(streaming.leaf, streaming.proof, regular.root, count)).toBe(true);
      }
    },
  );

  it("rejects an out-of-bounds leaf index", async () => {
    await expect(buildMerkleTreeStreamingWithProof(entries(3), 3)).rejects.toThrow(/out of bounds/);
    await expect(buildMerkleTreeStreamingWithProof(entries(3), -1)).rejects.toThrow(/out of bounds/);
  });
});
