"use strict";

const {
  computeRowHash,
  getPrevHash,
  getAnchorHash,
  recordAnchor,
  clearAnchor,
  verifyChain,
  GENESIS_PREV_HASH,
} = require("../services/auditChain");

/**
 * A tiny in-memory fake pg client. It returns canned rows for SELECTs based
 * on the query text and supports a simple `query(text, values)` signature so
 * it can stand in for a real pool in unit tests without a live Postgres.
 */
function makeFakeClient(rows = []) {
  let lastQuery = null;
  let lastValues = null;
  return {
    query(text, values) {
      lastQuery = text;
      lastValues = values || [];
      return Promise.resolve({ rows, rowCount: rows.length });
    },
    _lastQuery: () => lastQuery,
    _lastValues: () => lastValues,
  };
}

/**
 * A fake client that routes queries: any query touching `audit_chain_anchor`
 * returns `anchorRows`; everything else returns the audit-log `rows`.
 */
function makeChainClient(rows = [], anchorRows = []) {
  return {
    query(text) {
      if (text.includes("audit_chain_anchor")) {
        return Promise.resolve({ rows: anchorRows, rowCount: anchorRows.length });
      }
      return Promise.resolve({ rows, rowCount: rows.length });
    },
  };
}

function makeCapturingClient() {
  const calls = [];
  return {
    calls,
    query(text, values) {
      calls.push({ text, values });
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  };
}

describe("auditChain.computeRowHash", () => {
  it("is deterministic for identical inputs", () => {
    const input = {
      id: "abc",
      actor: "admin",
      action: "login",
      targetType: null,
      targetId: null,
      metadata: "{}",
      ipAddress: "127.0.0.1",
      created_at: "2026-07-16T00:00:00.000Z",
      prev_hash: GENESIS_PREV_HASH,
    };
    expect(computeRowHash(input)).toBe(computeRowHash({ ...input }));
  });

  it("produces a 64-char hex SHA-256", () => {
    const hash = computeRowHash({
      id: "x",
      actor: "a",
      action: "act",
      prev_hash: GENESIS_PREV_HASH,
    });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when a field changes", () => {
    const base = {
      id: "x",
      actor: "admin",
      action: "login",
      prev_hash: GENESIS_PREV_HASH,
    };
    expect(computeRowHash(base)).not.toBe(
      computeRowHash({ ...base, actor: "attacker" }),
    );
  });

  it("treats null/undefined metadata as empty for stability", () => {
    const a = computeRowHash({ id: "1", actor: "a", action: "b", metadata: null, prev_hash: GENESIS_PREV_HASH });
    const b = computeRowHash({ id: "1", actor: "a", action: "b", metadata: undefined, prev_hash: GENESIS_PREV_HASH });
    expect(a).toBe(b);
  });

  it("stringifies object metadata", () => {
    const asObj = computeRowHash({ id: "1", actor: "a", action: "b", metadata: { x: 1 }, prev_hash: GENESIS_PREV_HASH });
    const asStr = computeRowHash({ id: "1", actor: "a", action: "b", metadata: "{\"x\":1}", prev_hash: GENESIS_PREV_HASH });
    expect(asObj).toBe(asStr);
  });
});

describe("auditChain.getPrevHash", () => {
  it("returns '0' when the log is empty", async () => {
    const client = makeFakeClient([]);
    expect(await getPrevHash(client)).toBe(GENESIS_PREV_HASH);
  });

  it("returns the most recent row_hash", async () => {
    const client = makeFakeClient([
      { row_hash: "hash-newest" },
      { row_hash: "hash-older" },
    ]);
    expect(await getPrevHash(client)).toBe("hash-newest");
  });
});

describe("auditChain.getAnchorHash", () => {
  it("returns null when no anchor has been recorded", async () => {
    const client = makeChainClient([], []);
    expect(await getAnchorHash(client)).toBeNull();
  });

  it("returns the recorded anchor hash", async () => {
    const client = makeChainClient([], [{ anchor_hash: "abc" }]);
    expect(await getAnchorHash(client)).toBe("abc");
  });
});

describe("auditChain.recordAnchor / clearAnchor", () => {
  it("upserts the anchor into the singleton row", async () => {
    const client = makeCapturingClient();
    await recordAnchor(client, "hash123", "r5", "retention");
    expect(client.calls[0].text).toMatch(/INSERT INTO audit_chain_anchor/);
    expect(client.calls[0].values).toEqual([1, "hash123", "r5", "retention"]);
  });

  it("deletes the anchor row", async () => {
    const client = makeCapturingClient();
    await clearAnchor(client);
    expect(client.calls[0].text).toMatch(/DELETE FROM audit_chain_anchor/);
  });
});

describe("auditChain.verifyChain", () => {
  function buildChain() {
    // Build a valid 3-row chain using the real helper.
    const rows = [];
    let prev = GENESIS_PREV_HASH;
    const specs = [
      { id: "r1", actor: "admin", action: "a1", created_at: "2026-07-01T00:00:00.000Z" },
      { id: "r2", actor: "admin", action: "a2", created_at: "2026-07-02T00:00:00.000Z" },
      { id: "r3", actor: "ops", action: "a3", created_at: "2026-07-03T00:00:00.000Z" },
    ];
    for (const s of specs) {
      const rowHash = computeRowHash({
        id: s.id,
        actor: s.actor,
        action: s.action,
        targetType: null,
        targetId: null,
        metadata: "{}",
        ipAddress: null,
        created_at: s.created_at,
        prev_hash: prev,
      });
      rows.push({
        id: s.id,
        actor: s.actor,
        action: s.action,
        target_type: null,
        target_id: null,
        metadata: "{}",
        ip_address: null,
        created_at: s.created_at,
        prev_hash: prev,
        row_hash: rowHash,
      });
      prev = rowHash;
    }
    return rows;
  }

  it("returns valid:true for a clean chain", async () => {
    const client = makeFakeClient(buildChain());
    const result = await verifyChain(client);
    expect(result.valid).toBe(true);
    expect(result.checked).toBe(3);
  });

  it("returns valid:false with firstInvalidId when a middle row is tampered", async () => {
    const rows = buildChain();
    // Tamper with the middle row's action — breaks its row_hash AND the
    // next row's prev_hash link.
    rows[1].action = "HACKED";

    const client = makeFakeClient(rows);
    const result = await verifyChain(client);
    expect(result.valid).toBe(false);
    expect(result.firstInvalidId).toBe("r2");
  });

  it("detects tampering of the genesis row's prev_hash", async () => {
    const rows = buildChain();
    rows[0].prev_hash = "tampered";
    const client = makeFakeClient(rows);
    const result = await verifyChain(client);
    expect(result.valid).toBe(false);
    expect(result.firstInvalidId).toBe("r1");
  });

  it("resumes verification from a recorded anchor after pruning the prefix", async () => {
    const chain = buildChain();
    // Simulate pruning the genesis row (r1): r2 becomes the oldest survivor.
    const pruned = chain.slice(1);
    const anchor = pruned[0].prev_hash;
    const client = makeChainClient(pruned, [{ anchor_hash: anchor }]);

    const result = await verifyChain(client);
    expect(result.valid).toBe(true);
    expect(result.checked).toBe(2);
    expect(result.anchored).toBe(true);
  });

  it("rejects a pruned chain when the anchor does not match the surviving head", async () => {
    const chain = buildChain();
    const pruned = chain.slice(1);
    const client = makeChainClient(pruned, [{ anchor_hash: "0".repeat(64) }]);

    const result = await verifyChain(client);
    expect(result.valid).toBe(false);
    expect(result.firstInvalidId).toBe("r2");
    expect(result.anchored).toBe(true);
  });

  it("rejects a pruned chain when no anchor has been recorded", async () => {
    const chain = buildChain();
    const pruned = chain.slice(1);
    // No anchor row → verifyChain falls back to genesis '0', which must fail
    // because r2's prev_hash points at the deleted r1.
    const client = makeChainClient(pruned, []);

    const result = await verifyChain(client);
    expect(result.valid).toBe(false);
    expect(result.firstInvalidId).toBe("r2");
    expect(result.anchored).toBe(false);
  });
});
