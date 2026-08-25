"use strict";

const crypto = require("crypto");

// Domain-separation prefixes (RFC 6962-style). Leaves and internal nodes are
// committed with distinct leading bytes so a leaf hash can never be mistaken
// for an internal node hash, and the published root additionally commits to the
// leaf count so a proof cannot be replayed against a tree of a different shape.
const LEAF_PREFIX = Buffer.from([0x00]);
const NODE_PREFIX = Buffer.from([0x01]);
const ROOT_PREFIX = Buffer.from([0x02]);

/**
 * SHA-256 over the concatenation of the given byte chunks.
 * @param {Buffer[]} parts
 * @returns {Buffer}
 */
function sha256(parts) {
  return crypto.createHash("sha256").update(Buffer.concat(parts)).digest();
}

/**
 * Encode a non-negative integer as a fixed-width 4-byte big-endian buffer so
 * the leaf-count commitment in the root is unambiguous.
 * @param {number} value
 * @returns {Buffer}
 */
function uint32Buffer(value) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(value, 0);
  return buf;
}

/**
 * Number of internal levels of a Merkle tree with `leafCount` leaves.
 * @param {number} leafCount
 * @returns {number}
 */
function treeHeight(leafCount) {
  let height = 0;
  let count = leafCount;
  while (count > 1) {
    count = Math.ceil(count / 2);
    height += 1;
  }
  return height;
}

/**
 * Domain-separated leaf hash: SHA-256(0x00 || serializedEntry).
 * @param {Object} entry
 * @returns {Buffer}
 */
function leafHash(entry) {
  const serialized = `${entry.id}${entry.prevHash}${entry.action}${entry.actor}${entry.resource}${entry.timestamp}`;
  return sha256([LEAF_PREFIX, Buffer.from(serialized, "utf8")]);
}

/**
 * Domain-separated internal node hash: SHA-256(0x01 || left || right).
 * @param {Buffer} left
 * @param {Buffer} right
 * @returns {Buffer}
 */
function nodeHash(left, right) {
  return sha256([NODE_PREFIX, left, right]);
}

/**
 * Build a Merkle tree from audit-style entries.
 *
 * @param {Array<{id, prevHash, action, actor, resource, timestamp}>} entries
 * @returns {{root: Buffer, tree: Buffer[][], leafCount: number, height: number}}
 */
function buildMerkleTree(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("Cannot build a Merkle tree without entries");
  }
  const leaves = entries.map(leafHash);
  let level = leaves;
  const tree = [leaves];
  while (level.length > 1) {
    const nextLevel = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      // Duplicate-and-hash a trailing odd node instead of promoting it
      // unchanged, so the tree shape (and thus the leaf count) is unambiguous.
      const right = i + 1 < level.length ? level[i + 1] : left;
      nextLevel.push(nodeHash(left, right));
    }
    level = nextLevel;
    tree.push(level);
  }
  const leafCount = entries.length;
  const height = tree.length - 1;
  // Commit the raw root together with the leaf count. Without this, a three
  // leaf tree [A, B, C] and a four leaf tree [A, B, C, C] (where C is
  // duplicated) would share the same raw root.
  const root = sha256([ROOT_PREFIX, uint32Buffer(leafCount), level[0]]);
  return { root, tree, leafCount, height };
}

/**
 * Generate a Merkle inclusion proof for the leaf at `leafIndex`.
 *
 * @param {Buffer[][]} tree - levels produced by {@link buildMerkleTree}
 * @param {number} leafIndex
 * @returns {{leaf: Buffer, proof: Array<{position: string, hash: Buffer}>, leafCount: number, height: number}}
 */
function generateMerkleProof(tree, leafIndex) {
  if (!Array.isArray(tree) || tree.length === 0 || !Array.isArray(tree[0])) {
    throw new Error("Invalid Merkle tree");
  }
  const leaves = tree[0];
  if (!Number.isInteger(leafIndex) || leafIndex < 0 || leafIndex >= leaves.length) {
    throw new Error("Leaf index out of bounds");
  }
  const proof = [];
  let index = leafIndex;
  for (let levelIdx = 0; levelIdx < tree.length - 1; levelIdx++) {
    const level = tree[levelIdx];
    const isRight = index % 2 === 0;
    const siblingIdx = isRight ? index + 1 : index - 1;
    if (siblingIdx >= 0 && siblingIdx < level.length) {
      proof.push({
        position: isRight ? "right" : "left",
        hash: level[siblingIdx],
      });
    } else {
      // Trailing odd node: it was duplicated with itself during the build.
      proof.push({
        position: isRight ? "right" : "left",
        hash: level[index],
      });
    }
    index = Math.floor(index / 2);
  }
  return {
    leaf: leaves[leafIndex],
    proof,
    leafCount: leaves.length,
    height: tree.length - 1,
  };
}

/**
 * Verify a Merkle inclusion proof. `leafCount` binds the tree shape: the proof
 * must contain exactly `treeHeight(leafCount)` steps and the final root is
 * recomputed as SHA-256(0x02 || leafCount || rawRoot).
 *
 * @param {Buffer} leaf
 * @param {Array<{position: string, hash: Buffer}>} proof
 * @param {Buffer} root
 * @param {number} leafCount
 * @returns {boolean}
 */
function verifyMerkleProof(leaf, proof, root, leafCount) {
  if (!Buffer.isBuffer(leaf) || !Buffer.isBuffer(root)) return false;
  if (!Number.isInteger(leafCount) || leafCount < 1) return false;
  if (!Array.isArray(proof) || proof.length !== treeHeight(leafCount)) return false;

  let hash = leaf;
  for (const step of proof) {
    if (!step || !Buffer.isBuffer(step.hash)) return false;
    if (step.position !== "left" && step.position !== "right") return false;
    const left = step.position === "left" ? step.hash : hash;
    const right = step.position === "left" ? hash : step.hash;
    hash = nodeHash(left, right);
  }
  const committedRoot = sha256([ROOT_PREFIX, uint32Buffer(leafCount), hash]);
  return committedRoot.equals(root);
}

/**
 * A simple pinned Buffer pool to reduce GC pressure when building large trees.
 * Buffers are reused across levels; a buffer is only released back to the pool
 * once no higher level still references it. This avoids allocating a fresh
 * Buffer for every internal node during streaming construction.
 */
class BufferPool {
  constructor() {
    this._free = [];
    this._pinned = new Set();
  }

  /**
   * Acquire a 32-byte buffer from the pool, or allocate a new one if none free.
   * @returns {Buffer}
   */
  acquire() {
    const buf = this._free.pop();
    if (buf) {
      this._pinned.add(buf);
      return buf;
    }
    const fresh = Buffer.allocUnsafe(32);
    this._pinned.add(fresh);
    return fresh;
  }

  /**
   * Release a buffer back to the pool for reuse.
   * @param {Buffer} buf
   */
  release(buf) {
    if (this._pinned.delete(buf)) {
      this._free.push(buf);
    }
  }
}

/**
 * Compute SHA-256(0x01 || left || right) into the destination buffer.
 * @param {Buffer} left
 * @param {Buffer} right
 * @param {Buffer} dest - 32-byte destination buffer
 */
function nodeHashInto(left, right, dest) {
  const hash = nodeHash(left, right);
  hash.copy(dest);
}

/**
 * Build a Merkle tree from an async iterator of audit-style entries, streaming
 * level-by-level and discarding lower levels as higher ones are built. This keeps
 * peak memory bounded to the largest single level (the leaves) rather than the
 * full tree structure, and reuses pinned Buffers to reduce GC pressure.
 *
 * The returned object contains only the root, leafCount, and height — it does NOT
 * retain the full tree. To generate a proof for a specific leaf, use
 * {@link buildMerkleTreeStreamingWithProof} which retains only the sibling hashes
 * needed for that leaf's proof.
 *
 * @param {AsyncIterable<{id, prevHash, action, actor, resource, timestamp}>} entryIterator
 * @returns {Promise<{root: Buffer, leafCount: number, height: number}>}
 */
async function buildMerkleTreeStreaming(entryIterator) {
  const pool = new BufferPool();
  let leafCount = 0;
  let level = []; // current level of hashes (Buffers)

  // Phase 1: consume the iterator, computing leaf hashes. We must hold the
  // leaves (the largest level) to build the tree, but we discard each lower
  // level as soon as the next is built.
  for await (const entry of entryIterator) {
    level.push(leafHash(entry));
    leafCount += 1;
  }

  if (leafCount === 0) {
    throw new Error("Cannot build a Merkle tree without entries");
  }

  // Phase 2: collapse level-by-level, discarding each lower level as the next
  // is built. Only the current level is retained in memory at any time.
  let height = 0;
  while (level.length > 1) {
    const nextLevel = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      // Duplicate-and-hash a trailing odd node (same shape as buildMerkleTree).
      const right = i + 1 < level.length ? level[i + 1] : left;
      const parent = pool.acquire();
      nodeHashInto(left, right, parent);
      nextLevel.push(parent);
      pool.release(left);
      if (right !== left) pool.release(right);
    }
    level = nextLevel;
    height += 1;
  }

  const root = sha256([ROOT_PREFIX, uint32Buffer(leafCount), level[0]]);
  return { root, leafCount, height };
}

/**
 * Build a Merkle tree from an async iterator while retaining only the sibling
 * hashes needed to generate an inclusion proof for `leafIndex`. This is the
 * memory-efficient equivalent of {@link buildMerkleTree} + {@link generateMerkleProof}
 * for large datasets: lower levels are discarded as higher ones are built, and
 * only the proof siblings are retained.
 *
 * @param {AsyncIterable<{id, prevHash, action, actor, resource, timestamp}>} entryIterator
 * @param {number} leafIndex - index of the leaf to generate a proof for
 * @returns {Promise<{leaf: Buffer, proof: Array<{position: string, hash: Buffer}>, root: Buffer, leafCount: number, height: number}>}
 */
async function buildMerkleTreeStreamingWithProof(entryIterator, leafIndex) {
  const pool = new BufferPool();
  let leafCount = 0;
  let level = [];
  let targetLeaf = null;

  // Phase 1: consume the iterator, computing leaf hashes.
  for await (const entry of entryIterator) {
    const leaf = leafHash(entry);
    if (leafCount === leafIndex) {
      targetLeaf = leaf;
    }
    level.push(leaf);
    leafCount += 1;
  }

  if (leafCount === 0) {
    throw new Error("Cannot build a Merkle tree without entries");
  }
  if (!Number.isInteger(leafIndex) || leafIndex < 0 || leafIndex >= leafCount) {
    throw new Error("Leaf index out of bounds");
  }

  // Phase 2: collapse level-by-level, capturing the proof path for the target
  // leaf and discarding each lower level as the next is built.
  const proof = [];
  let index = leafIndex;
  let height = 0;
  while (level.length > 1) {
    const nextLevel = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : left;
      const parent = pool.acquire();
      nodeHashInto(left, right, parent);
      nextLevel.push(parent);
      pool.release(left);
      if (right !== left) pool.release(right);

      // If this pair contains the target leaf's current index, record the sibling.
      if (i === index || i + 1 === index) {
        const isRight = i === index;
        const sibling = isRight ? right : left;
        proof.push({
          position: isRight ? "right" : "left",
          hash: Buffer.from(sibling),
        });
      }
    }
    level = nextLevel;
    index = Math.floor(index / 2);
    height += 1;
  }

  const root = sha256([ROOT_PREFIX, uint32Buffer(leafCount), level[0]]);
  return {
    leaf: targetLeaf,
    proof,
    root,
    leafCount,
    height,
  };
}

module.exports = {
  buildMerkleTree,
  buildMerkleTreeStreaming,
  buildMerkleTreeStreamingWithProof,
  generateMerkleProof,
  verifyMerkleProof,
};
