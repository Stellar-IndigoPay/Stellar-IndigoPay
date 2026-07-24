"use strict";

/**
 * src/services/consistentHash.js
 *
 * Consistent hashing ring for routing rate-limit keys to specific Redis
 * shards. Uses MD5 hashing with 150 virtual nodes per physical node for
 * even key distribution, with binary search for O(log V) lookups.
 *
 * Properties:
 *   - Adding/removing a node redistributes approximately 1/N of keys
 *   - The same key always maps to the same node when the ring is stable
 *   - Fallback to index 0 when the ring is empty
 */

const crypto = require("crypto");

class ConsistentHashRing {
  /**
   * @param {string[]} nodes  - Logical node names (e.g. ["shard-0", "shard-1"])
   * @param {number}   [virtualNodes=150] - Virtual replicas per physical node
   */
  constructor(nodes = [], virtualNodes = 150) {
    this.virtualNodes = virtualNodes;
    /** @type {Map<number, number>} hash → node index in this.nodes */
    this.ring = new Map();
    /** @type {number[]} sorted list of virtual-node hashes */
    this.sortedHashes = [];
    /** @type {string[]} ordered logical node names */
    this.nodes = [];

    for (const node of nodes) {
      this.addNode(node);
    }
  }

  /**
   * Hash a key to a 32-bit unsigned integer using MD5.
   * @param {string} key
   * @returns {number}
   */
  _hash(key) {
    return parseInt(
      crypto.createHash("md5").update(String(key)).digest("hex").slice(0, 8),
      16,
    );
  }

  /**
   * Add a physical node to the ring with `virtualNodes` replicas.
   * @param {string} node - Logical node name
   */
  addNode(node) {
    this.nodes.push(node);
    const nodeIndex = this.nodes.length - 1;

    for (let i = 0; i < this.virtualNodes; i++) {
      const hash = this._hash(`${node}:${i}`);
      this.ring.set(hash, nodeIndex);
      this.sortedHashes.push(hash);
    }
    this.sortedHashes.sort((a, b) => a - b);
  }

  /**
   * Remove a physical node and all its virtual replicas.
   * Used for testing redistribution behaviour; production would typically
   * rebuild the ring rather than mutate in place.
   * @param {string} node - Logical node name to remove
   */
  removeNode(node) {
    const idx = this.nodes.indexOf(node);
    if (idx === -1) return;

    // Remove node and compact the index
    this.nodes.splice(idx, 1);

    // Rebuild ring from remaining nodes
    this.ring.clear();
    this.sortedHashes = [];

    // Re-index remaining nodes
    for (let ni = 0; ni < this.nodes.length; ni++) {
      for (let vi = 0; vi < this.virtualNodes; vi++) {
        const hash = this._hash(`${this.nodes[ni]}:${vi}`);
        this.ring.set(hash, ni);
        this.sortedHashes.push(hash);
      }
    }
    this.sortedHashes.sort((a, b) => a - b);
  }

  /**
   * Return the physical node responsible for `key`.
   *
   * Uses binary search to find the first virtual-node hash >= key hash
   * (wrapping around to the start when necessary).
   *
   * @param {string} key - Rate-limit key to route
   * @returns {string|null} Logical node name, or null if the ring is empty
   */
  getNode(key) {
    if (this.nodes.length === 0) return null;
    if (this.nodes.length === 1) return this.nodes[0];

    const hash = this._hash(key);

    // Binary search for the first hash >= key hash
    let low = 0;
    let high = this.sortedHashes.length - 1;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (this.sortedHashes[mid] < hash) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }

    // Wrap around if key hash is greater than all virtual-node hashes.
    // `sortedHashes` is guaranteed non-empty when nodes.length > 1.
    const nodeHash = this.sortedHashes[low] >= hash
      ? this.sortedHashes[low]
      : this.sortedHashes[0];

    const nodeIndex = this.ring.get(nodeHash);
    return this.nodes[nodeIndex];
  }

  /**
   * Count how many of the provided keys would route to each node.
   * Useful for distribution tests.
   * @param {string[]} keys
   * @returns {Map<string, number>} node → key count
   */
  distribution(keys) {
    const counts = new Map();
    for (const node of this.nodes) {
      counts.set(node, 0);
    }
    for (const key of keys) {
      const node = this.getNode(key);
      if (node !== null) {
        counts.set(node, (counts.get(node) || 0) + 1);
      }
    }
    return counts;
  }
}

module.exports = { ConsistentHashRing };
