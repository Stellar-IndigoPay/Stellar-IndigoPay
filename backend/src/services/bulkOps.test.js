"use strict";

/**
 * Unit tests for the bulk-op ledger engine (src/services/bulkOps.js).
 *
 * Uses a synthetic "test_widget" op type backed by a plain in-memory array
 * (ignoring the DB client entirely) so these tests exercise the generic
 * ledger mechanics — hashing, drift detection, batching, outcome recording,
 * CAS confirm, expiry — independent of any real table.
 */

jest.mock("../db/pool", () => {
  const { FakeBulkOpsPool } = require("../test-helpers/fakeBulkOpsPool");
  return new FakeBulkOpsPool();
});

jest.mock("./audit", () => ({
  logAdminAction: jest.fn().mockResolvedValue(undefined),
}));

const pool = require("../db/pool");
const { logAdminAction } = require("./audit");
const bulkOps = require("./bulkOps");

let widgets;

function seedWidgets(rows) {
  widgets = new Map(rows.map((w) => [w.id, { ...w }]));
}

bulkOps.registerOpType("test_widget", {
  destructive: true,
  validateParams(params) {
    if (!params || !params.active) return "active is required";
    return null;
  },
  async buildScope(params) {
    const rows = [...widgets.values()].filter((w) => w.active === params.active);
    return {
      filters: { active: params.active },
      scopeIds: rows.map((w) => w.id),
      sample: rows.map((w) => ({ id: w.id, name: w.name })),
    };
  },
  async executeRow(id) {
    const widget = widgets.get(id);
    if (widget.explode) throw new Error("widget exploded");
    widget.active = false;
    widget.touched = true;
    return { outcome: "changed" };
  },
});

bulkOps.registerOpType("test_widget_nondestructive", {
  destructive: false,
  validateParams() {
    return null;
  },
  async buildScope() {
    return { filters: {}, scopeIds: [...widgets.keys()], sample: [] };
  },
  async executeRow(id) {
    widgets.get(id).touched = true;
    return { outcome: "changed" };
  },
});

beforeEach(() => {
  jest.clearAllMocks();
  pool.bulkOps.clear();
  seedWidgets([
    { id: "w1", name: "A", active: true },
    { id: "w2", name: "B", active: true },
    { id: "w3", name: "C", active: true },
  ]);
});

describe("createPreview", () => {
  test("is side-effect-free: no widget is touched", async () => {
    const op = await bulkOps.createPreview({ type: "test_widget", params: { active: true }, actor: "alice" });
    expect(op.status).toBe("preview");
    expect(op.previewCount).toBe(3);
    expect([...widgets.values()].every((w) => !w.touched)).toBe(true);
  });

  test("rejects an unknown op type", async () => {
    await expect(
      bulkOps.createPreview({ type: "nope", params: {}, actor: "alice" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", metadata: { detail: expect.stringMatching(/Unknown bulk-op type/) } });
  });

  test("rejects invalid params via the op type's validator", async () => {
    await expect(
      bulkOps.createPreview({ type: "test_widget", params: {}, actor: "alice" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", metadata: { detail: expect.stringMatching(/active is required/) } });
  });

  test("records a bulk_op.preview audit entry", async () => {
    await bulkOps.createPreview({ type: "test_widget", params: { active: true }, actor: "alice" });
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ actor: "alice", action: "bulk_op.preview", targetType: "bulk_op" }),
    );
  });
});

describe("confirmOp", () => {
  test("applies exactly the previewed scope and records per-row outcomes", async () => {
    const preview = await bulkOps.createPreview({ type: "test_widget", params: { active: true }, actor: "alice" });
    const confirmed = await bulkOps.confirmOp({
      id: preview.id, params: { active: true }, confirm: true, actor: "alice",
    });

    expect(confirmed.status).toBe("completed");
    expect(confirmed.outcomes.total).toBe(3);
    expect(confirmed.outcomes.changed).toBe(3);
    expect(confirmed.outcomes.rows.map((r) => r.id).sort()).toEqual(["w1", "w2", "w3"]);
    expect(widgets.get("w1").touched).toBe(true);
    expect(widgets.get("w2").touched).toBe(true);
    expect(widgets.get("w3").touched).toBe(true);
  });

  test("flags rows that dropped out of scope since preview, and never executes rows that newly match", async () => {
    const preview = await bulkOps.createPreview({ type: "test_widget", params: { active: true }, actor: "alice" });

    // w3 stops matching (someone else deactivated it); w4 starts matching (new row).
    widgets.get("w3").active = false;
    widgets.set("w4", { id: "w4", name: "D", active: true });

    const confirmed = await bulkOps.confirmOp({
      id: preview.id, params: { active: true }, confirm: true, actor: "alice",
    });

    const w3Outcome = confirmed.outcomes.rows.find((r) => r.id === "w3");
    expect(w3Outcome).toEqual({ id: "w3", outcome: "skipped", reason: "scope_drift_removed" });
    expect(confirmed.outcomes.rows.some((r) => r.id === "w4")).toBe(false);
    expect(confirmed.outcomes.scopeDrift).toEqual({ removed: 1, added: 1, addedSample: ["w4"] });
    expect(widgets.get("w4").touched).toBeUndefined();
    expect(widgets.get("w1").touched).toBe(true);
    expect(widgets.get("w2").touched).toBe(true);
  });

  test("partial failure: one failing row does not silently skip or abort the rest", async () => {
    widgets.get("w2").explode = true;
    const preview = await bulkOps.createPreview({ type: "test_widget", params: { active: true }, actor: "alice" });
    const confirmed = await bulkOps.confirmOp({
      id: preview.id, params: { active: true }, confirm: true, actor: "alice",
    });

    expect(confirmed.status).toBe("partial");
    expect(confirmed.outcomes.changed).toBe(2);
    expect(confirmed.outcomes.failed).toBe(1);
    const failedRow = confirmed.outcomes.rows.find((r) => r.id === "w2");
    expect(failedRow.outcome).toBe("failed");
    expect(failedRow.reason).toMatch(/widget exploded/);
    expect(widgets.get("w1").touched).toBe(true);
    expect(widgets.get("w3").touched).toBe(true);
  });

  test("rejects a params payload that doesn't match the previewed hash (tamper detection)", async () => {
    const preview = await bulkOps.createPreview({ type: "test_widget", params: { active: true }, actor: "alice" });
    await expect(
      bulkOps.confirmOp({ id: preview.id, params: { active: false }, confirm: true, actor: "alice" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", metadata: { detail: expect.stringMatching(/params do not match/) } });
    const reloaded = await bulkOps.getOp(preview.id);
    expect(reloaded.status).toBe("failed");
  });

  test("destructive ops require an explicit confirm: true flag", async () => {
    const preview = await bulkOps.createPreview({ type: "test_widget", params: { active: true }, actor: "alice" });
    await expect(
      bulkOps.confirmOp({ id: preview.id, params: { active: true }, actor: "alice" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", metadata: { detail: expect.stringMatching(/confirm: true/) } });
  });

  test("non-destructive ops do not require the confirm flag", async () => {
    const preview = await bulkOps.createPreview({ type: "test_widget_nondestructive", params: {}, actor: "alice" });
    const confirmed = await bulkOps.confirmOp({ id: preview.id, params: {}, actor: "alice" });
    expect(confirmed.status).toBe("completed");
  });

  test("records a bulk_op.confirm audit entry with a scope summary, no row payloads", async () => {
    const preview = await bulkOps.createPreview({ type: "test_widget", params: { active: true }, actor: "alice" });
    await bulkOps.confirmOp({ id: preview.id, params: { active: true }, confirm: true, actor: "alice" });

    const confirmCall = logAdminAction.mock.calls.find(([arg]) => arg.action === "bulk_op.confirm");
    expect(confirmCall).toBeDefined();
    expect(confirmCall[0].metadata.scopeSummary).toEqual(
      expect.objectContaining({ total: 3, changed: 3, failed: 0 }),
    );
    expect(JSON.stringify(confirmCall[0].metadata)).not.toMatch(/"name"/);
  });

  test("a second concurrent confirm on the same op is rejected (CAS, no double-execution)", async () => {
    const preview = await bulkOps.createPreview({ type: "test_widget", params: { active: true }, actor: "alice" });
    const [first, second] = await Promise.allSettled([
      bulkOps.confirmOp({ id: preview.id, params: { active: true }, confirm: true, actor: "alice" }),
      bulkOps.confirmOp({ id: preview.id, params: { active: true }, confirm: true, actor: "bob" }),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual(["fulfilled", "rejected"]);
    expect(widgets.get("w1").touched).toBe(true); // executed exactly once
  });

  test("confirming an already-cancelled op is rejected", async () => {
    const preview = await bulkOps.createPreview({ type: "test_widget", params: { active: true }, actor: "alice" });
    await bulkOps.cancelOp({ id: preview.id, actor: "alice" });
    await expect(
      bulkOps.confirmOp({ id: preview.id, params: { active: true }, confirm: true, actor: "alice" }),
    ).rejects.toMatchObject({ code: "CONFLICT", metadata: { reason: expect.stringMatching(/already cancelled/) } });
  });

  test("an expired preview cannot be confirmed", async () => {
    const preview = await bulkOps.createPreview({
      type: "test_widget", params: { active: true }, actor: "alice", ttlMs: -60000,
    });
    await expect(
      bulkOps.confirmOp({ id: preview.id, params: { active: true }, confirm: true, actor: "alice" }),
    ).rejects.toMatchObject({ code: "CONFLICT", metadata: { reason: expect.stringMatching(/expired/) } });
    const reloaded = await bulkOps.getOp(preview.id);
    expect(reloaded.status).toBe("expired");
  });
});

describe("cancelOp", () => {
  test("cancels a preview and records an audit entry", async () => {
    const preview = await bulkOps.createPreview({ type: "test_widget", params: { active: true }, actor: "alice" });
    const cancelled = await bulkOps.cancelOp({ id: preview.id, actor: "alice" });
    expect(cancelled.status).toBe("cancelled");
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "bulk_op.cancel", targetId: preview.id }),
    );
  });

  test("cannot cancel an already-confirmed op", async () => {
    const preview = await bulkOps.createPreview({ type: "test_widget", params: { active: true }, actor: "alice" });
    await bulkOps.confirmOp({ id: preview.id, params: { active: true }, confirm: true, actor: "alice" });
    await expect(bulkOps.cancelOp({ id: preview.id, actor: "alice" })).rejects.toMatchObject({
      code: "CONFLICT", metadata: { reason: expect.stringMatching(/already completed/) },
    });
  });
});

describe("listOps", () => {
  test("lists ops filtered by status", async () => {
    const a = await bulkOps.createPreview({ type: "test_widget", params: { active: true }, actor: "alice" });
    await bulkOps.cancelOp({ id: a.id, actor: "alice" });
    await bulkOps.createPreview({ type: "test_widget", params: { active: true }, actor: "alice" });

    const cancelled = await bulkOps.listOps({ status: "cancelled" });
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0].id).toBe(a.id);
  });
});
