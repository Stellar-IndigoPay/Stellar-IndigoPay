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
 * A simple pinned Buffer pool to reduce temporary-object GC pressure during
 * streaming tree construction. Buffers are reused across levels where possible.
 */
class BufferPool {
  constructor() {
    this._pool = [];
  }

  /**
   * Acquire a Buffer of at least `size` bytes, reusing a pooled buffer if one
   * of sufficient capacity is available.
   * @param {number} size
   * @returns {Buffer}
   */
  acquire(size) {
    for (let i = 0; i < this._pool.length; i += 1) {
      if (this._pool[i].length >= size) {
        return this._pool.splice(i, 1)[0];
      }
    }
    return Buffer.alloc(size);
  }

  /**
   * Return a buffer to the pool for reuse.
   * @param {Buffer} buf
   */
  release(buf) {
    if (Buffer.isBuffer(buf)) {
      this._pool.push(buf);
    }
  }
}

/**
 * Build a Merkle tree from an async iterator of audit-style entries, streaming
 * level-by-level. The input entries are consumed lazily from the iterator so
 * the caller never needs to hold the full entry array in memory at once. The
 * resulting tree is fully compatible with {@link generateMerkleProof}.
 *
 * @param {AsyncIterable<{id, prevHash, action, actor, resource, timestamp}>} entryIterator
 * @returns {Promise<{root: Buffer, tree: Buffer[][], leafCount: number, height: number}>}
 */
async function buildMerkleTreeStreaming(entryIterator) {
  const pool = new BufferPool();

  // Stream the leaf hashes from the iterator, reusing pooled buffers where
  // possible to reduce GC pressure.
  const leaves = [];
  for await (const entry of entryIterator) {
    // Serialize into a pooled buffer to reduce temporary-object GC pressure.
    const serialized = `${entry.id}${entry.prevHash}${entry.action}${entry.actor}${entry.resource}${entry.timestamp}`;
    const serializedBuf = pool.acquire(Buffer.byteLength(serialized, "utf8"));
    serializedBuf.write(serialized, 0, "utf8");
    leaves.push(sha256([LEAF_PREFIX, serializedBuf]));
    pool.release(serializedBuf);
  }
  if (leaves.length === 0) {
    throw new Error("Cannot build a Merkle tree without entries");
  }

  const leafCount = leaves.length;
  let level = leaves;
  const tree = [level];

  while (level.length > 1) {
    const nextLevel = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : left;
      const hash = nodeHash(left, right);
      nextLevel.push(hash);
    }
    level = nextLevel;
    tree.push(level);
  }

  const height = tree.length - 1;
  const root = sha256([ROOT_PREFIX, uint32Buffer(leafCount), level[0]]);
  return { root, tree, leafCount, height };
}

module.exports = {
  buildMerkleTree,
  buildMerkleTreeStreaming,
  generateMerkleProof,
  verifyMerkleProof,
};
