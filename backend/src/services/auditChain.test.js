"use strict";

const {
  computeRowHash,
  getPrevHash,
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
});
