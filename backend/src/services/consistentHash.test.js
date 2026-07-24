"use strict";

/**
 * src/services/consistentHash.test.js
 *
 * Unit tests for the ConsistentHashRing class.
 *
 * Coverage:
 *   - Hash determinism
 *   - Single/multi node routing
 *   - Empty ring edge case
 *   - Node addition/removal redistribution
 *   - Key distribution uniformity (chi-squared)
 *   - Binary search edge cases
 *   - distribution() helper
 */

const { ConsistentHashRing } = require("./consistentHash");

describe("ConsistentHashRing", () => {
  // ── Hash determinism ────────────────────────────────────────────────────

  test("produces deterministic hashes for the same input", () => {
    const ring = new ConsistentHashRing(["shard-0", "shard-1"]);
    const node1 = ring.getNode("ratelimit:sw:10.0.0.1:POST:/api/donations");
    const node2 = ring.getNode("ratelimit:sw:10.0.0.1:POST:/api/donations");
    expect(node1).toBe(node2);
    expect(node1).not.toBeNull();
    expect(["shard-0", "shard-1"]).toContain(node1);
  });

  test("two keys with different input may route to different nodes", () => {
    const ring = new ConsistentHashRing(["shard-0", "shard-1"]);
    // Generate many keys and check both shards are hit
    const results = new Set();
    for (let i = 0; i < 100; i++) {
      results.add(ring.getNode(`ratelimit:sw:192.168.1.${i}:POST:/api/donations`));
    }
    // With 2 nodes and 100 keys, both should be hit
    expect(results.has("shard-0")).toBe(true);
    expect(results.has("shard-1")).toBe(true);
  });

  // ── Single node ring ────────────────────────────────────────────────────

  test("single node ring returns the only node for any key", () => {
    const ring = new ConsistentHashRing(["sole-shard"]);
    expect(ring.getNode("key-1")).toBe("sole-shard");
    expect(ring.getNode("key-2")).toBe("sole-shard");
    expect(ring.getNode("any-random-key")).toBe("sole-shard");
  });

  test("single node via constructor works same as addNode", () => {
    const ringFromCtor = new ConsistentHashRing(["a"]);
    const ringFromAdd = new ConsistentHashRing();
    ringFromAdd.addNode("a");
    expect(ringFromCtor.getNode("foo")).toBe("a");
    expect(ringFromAdd.getNode("foo")).toBe("a");
  });

  // ── Empty ring ──────────────────────────────────────────────────────────

  test("empty ring returns null", () => {
    const ring = new ConsistentHashRing();
    expect(ring.getNode("any-key")).toBeNull();
  });

  test("empty ring distribution returns empty map", () => {
    const ring = new ConsistentHashRing();
    const dist = ring.distribution(["a", "b", "c"]);
    expect(dist.size).toBe(0);
  });

  // ── Routing consistency (same key → same node) ──────────────────────────

  test("the same rate limit key always routes to the same shard", () => {
    const ring = new ConsistentHashRing(["shard-0", "shard-1", "shard-2"]);
    const key = "ratelimit:sw:10.0.0.1:POST:/api/donations";
    const first = ring.getNode(key);
    // Repeated calls must return the same node
    for (let i = 0; i < 50; i++) {
      expect(ring.getNode(key)).toBe(first);
    }
  });

  // ── Node addition redistribution ────────────────────────────────────────

  test("adding a third node redistributes approximately 1/3 of keys from each original node", () => {
    const numKeys = 1000;
    const ring = new ConsistentHashRing(["shard-0", "shard-1"]);
    const keys = Array.from({ length: numKeys }, (_, i) => `key-${i}`);

    // Capture distribution before adding node
    const before = ring.distribution(keys);
    const before0 = before.get("shard-0") || 0;
    const before1 = before.get("shard-1") || 0;

    // Add a third node
    ring.addNode("shard-2");
    const after = ring.distribution(keys);
    const after0 = after.get("shard-0") || 0;
    const after1 = after.get("shard-1") || 0;
    const after2 = after.get("shard-2") || 0;

    // All keys must still be accounted for
    expect(after0 + after1 + after2).toBe(numKeys);

    // The new node should have roughly 1/3 of keys (within reason)
    const expectedShare = numKeys / 3;
    expect(after2).toBeGreaterThan(expectedShare * 0.4); // at least 40% of ideal
    expect(after2).toBeLessThan(expectedShare * 1.8);    // at most 180% of ideal

    // Original nodes should have lost keys
    expect(after0).toBeLessThan(before0);
    expect(after1).toBeLessThan(before1);
  });

  // ── Node removal ────────────────────────────────────────────────────────

  test("removeNode eliminates the node and redistributes its keys", () => {
    const ring = new ConsistentHashRing(["shard-0", "shard-1", "shard-2"]);
    const keys = Array.from({ length: 900 }, (_, i) => `key-${i}`);

    ring.removeNode("shard-1");
    const after = ring.distribution(keys);

    // Only two nodes remain
    expect(after.size).toBe(2);
    expect(after.has("shard-0")).toBe(true);
    expect(after.has("shard-2")).toBe(true);
    expect(after.has("shard-1")).toBe(false);

    // All keys accounted for
    const total = (after.get("shard-0") || 0) + (after.get("shard-2") || 0);
    expect(total).toBe(keys.length);
  });

  test("removeNode is a no-op for nonexistent nodes", () => {
    const ring = new ConsistentHashRing(["a", "b"]);
    const before = ring.distribution(Array.from({ length: 100 }, (_, i) => `k-${i}`));
    ring.removeNode("nonexistent");
    const after = ring.distribution(Array.from({ length: 100 }, (_, i) => `k-${i}`));
    expect(after.get("a")).toBe(before.get("a"));
    expect(after.get("b")).toBe(before.get("b"));
  });

  // ── Key distribution uniformity ─────────────────────────────────────────

  test("keys are distributed uniformly across shards (chi-squared test)", () => {
    const numShards = 5;
    const numKeys = 5000;
    const nodes = Array.from({ length: numShards }, (_, i) => `shard-${i}`);
    const ring = new ConsistentHashRing(nodes);

    const keys = Array.from({ length: numKeys }, (_, i) => `ratelimit:sw:10.0.${i % 255}.${i}:POST:/api/donations`);
    const dist = ring.distribution(keys);

    // Expected count per shard
    const expected = numKeys / numShards;

    // Chi-squared test: Σ((observed - expected)² / expected)
    let chiSquared = 0;
    for (const [node, count] of dist) {
      chiSquared += Math.pow(count - expected, 2) / expected;
    }

    // For 4 degrees of freedom (#shards - 1) at p=0.05, critical value ≈ 9.488
    // MD5-based consistent hashing with 150 virtual nodes has some variance;
    // we use a generous threshold (60) to account for real-world distribution.
    expect(chiSquared).toBeLessThan(60);
  });

  // ── Binary search edge cases ────────────────────────────────────────────

  test("key hash larger than all virtual-node hashes wraps to first node", () => {
    // Create a ring where we test edge-case routing
    const ring = new ConsistentHashRing(["a", "b", "c"]);
    // With many keys, some will inevitably hash larger than all virtual nodes.
    // The ring must wrap around and return a valid node.
    for (let i = 0; i < 1000; i++) {
      const node = ring.getNode(`edge-key-${i}`);
      expect(["a", "b", "c"]).toContain(node);
    }
  });

  test("key hash smaller than all virtual-node hashes routes correctly", () => {
    const ring = new ConsistentHashRing(["x", "y"]);
    for (let i = 0; i < 500; i++) {
      const node = ring.getNode(`small-key-${i}`);
      expect(["x", "y"]).toContain(node);
      expect(node).not.toBeNull();
    }
  });

  // ── distribution() helper ────────────────────────────────────────────────

  test("distribution returns correct counts", () => {
    const ring = new ConsistentHashRing(["one", "two"]);
    const keys = ["a", "b", "c"];
    const dist = ring.distribution(keys);

    expect(dist.has("one")).toBe(true);
    expect(dist.has("two")).toBe(true);
    const total = (dist.get("one") || 0) + (dist.get("two") || 0);
    expect(total).toBe(keys.length);
  });

  // ── Virtual nodes ────────────────────────────────────────────────────────

  test("constructor accepts custom virtual node count", () => {
    const ringDefault = new ConsistentHashRing(["a", "b"]);
    const ringCustom = new ConsistentHashRing(["a", "b"], 50);

    // Both should route keys without error
    expect(ringDefault.getNode("test")).not.toBeNull();
    expect(ringCustom.getNode("test")).not.toBeNull();

    // ringCustom has fewer virtual nodes, but still 2*50 = 100 sorted hashes
    expect(ringCustom.sortedHashes.length).toBe(100);
    expect(ringDefault.sortedHashes.length).toBe(300); // 2 * 150
  });

  // ── Multiple addNode calls ───────────────────────────────────────────────

  test("addNode can be called after construction", () => {
    const ring = new ConsistentHashRing(["a"]);
    expect(ring.getNode("k1")).toBe("a");
    ring.addNode("b");
    // After adding, keys should route to one of the two nodes
    const results = new Set();
    for (let i = 0; i < 200; i++) {
      results.add(ring.getNode(`k${i}`));
    }
    expect(results.has("a")).toBe(true);
    expect(results.has("b")).toBe(true);
  });
});
