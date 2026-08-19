"use strict";

/**
 * Integration tests for the admin bulk-op ledger routes (#934), exercised
 * through the real "project_bulk_deactivate" op type registered in
 * ./bulkOps.js against a fake in-memory `projects` table.
 */

jest.mock("../../db/pool", () => {
  const { FakeBulkOpsPool } = require("../../test-helpers/fakeBulkOpsPool");
  const projects = new Map();

  const projectsHandler = (s, values) => {
    if (s.startsWith("SELECT id, name, status FROM projects WHERE")) {
      let rows = [...projects.values()].filter((p) => !p.deactivated_at);
      let vi = 0;
      if (s.includes("status = $")) {
        rows = rows.filter((p) => p.status === values[vi]);
        vi++;
      }
      if (s.includes("category = $")) {
        rows = rows.filter((p) => p.category === values[vi]);
        vi++;
      }
      rows.sort((a, b) => a.id.localeCompare(b.id));
      return { rows: rows.map((p) => ({ id: p.id, name: p.name, status: p.status })) };
    }
    if (s.startsWith("UPDATE projects SET status = 'inactive'")) {
      const [id] = values;
      const p = projects.get(id);
      if (p && p.explode) {
        throw new Error("simulated constraint violation");
      }
      if (p && !p.deactivated_at) {
        p.status = "inactive";
        p.deactivated_at = new Date();
        return { rows: [{ id }] };
      }
      return { rows: [] };
    }
    return undefined;
  };

  const fake = new FakeBulkOpsPool({ extraHandlers: [projectsHandler] });
  fake.projects = projects;
  return fake;
});

jest.mock("../../services/audit", () => ({
  logAdminAction: jest.fn().mockResolvedValue(undefined),
}));

process.env.ADMIN_API_KEY = "test-admin-key";
process.env.JWT_SECRET = "test-secret-for-jest";

const express = require("express");
const request = require("supertest");
const pool = require("../../db/pool");
const { logAdminAction } = require("../../services/audit");
const bulkOpsRouter = require("./bulkOps");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/admin/bulk-ops", bulkOpsRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: { code: err.code || "INTERNAL_ERROR", message: err.message, ...err.metadata } });
  });
  return app;
}

function seedProject(id, overrides = {}) {
  pool.projects.set(id, {
    id, name: `Project ${id}`, status: "paused", category: "Reforestation",
    deactivated_at: null, ...overrides,
  });
}

function adminReq(app) {
  return {
    get: (path) => request(app).get(path).set("X-Admin-Key", "test-admin-key"),
    post: (path) => request(app).post(path).set("X-Admin-Key", "test-admin-key"),
  };
}

describe("Admin bulk-ops router", () => {
  let app;
  let admin;

  beforeEach(() => {
    jest.clearAllMocks();
    pool.bulkOps.clear();
    pool.projects.clear();
    app = buildApp();
    admin = adminReq(app);
  });

  test("requires admin auth", async () => {
    await request(app).post("/api/admin/bulk-ops/project_bulk_deactivate/preview").send({}).expect(401);
  });

  test("preview computes scope and counts without changing any project", async () => {
    seedProject("p1", { status: "paused" });
    seedProject("p2", { status: "paused" });
    seedProject("p3", { status: "active" });

    const res = await admin
      .post("/api/admin/bulk-ops/project_bulk_deactivate/preview")
      .send({ filter: { status: "paused" }, reason: "quarterly cleanup" });

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe("preview");
    expect(res.body.data.previewCount).toBe(2);
    expect(pool.projects.get("p1").status).toBe("paused");
    expect(pool.projects.get("p2").status).toBe("paused");
  });

  test("rejects an unscoped filter", async () => {
    const res = await admin
      .post("/api/admin/bulk-ops/project_bulk_deactivate/preview")
      .send({ filter: {}, reason: "oops" });
    expect(res.status).toBe(400);
  });

  test("confirm without confirm:true is rejected (destructive op)", async () => {
    seedProject("p1", { status: "paused" });
    const params = { filter: { status: "paused" }, reason: "quarterly cleanup" };
    const preview = await admin
      .post("/api/admin/bulk-ops/project_bulk_deactivate/preview")
      .send(params);

    const res = await admin
      .post(`/api/admin/bulk-ops/${preview.body.data.id}/confirm`)
      .send({ params });

    expect(res.status).toBe(400);
    expect(pool.projects.get("p1").status).toBe("paused");
  });

  test("confirm applies exactly the previewed scope and deactivates matching projects", async () => {
    seedProject("p1", { status: "paused" });
    seedProject("p2", { status: "paused" });
    const params = { filter: { status: "paused" }, reason: "quarterly cleanup" };
    const preview = await admin
      .post("/api/admin/bulk-ops/project_bulk_deactivate/preview")
      .send(params);

    const res = await admin
      .post(`/api/admin/bulk-ops/${preview.body.data.id}/confirm`)
      .send({ params, confirm: true });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("completed");
    expect(res.body.data.outcomes.changed).toBe(2);
    expect(pool.projects.get("p1").status).toBe("inactive");
    expect(pool.projects.get("p2").status).toBe("inactive");

    const confirmCall = logAdminAction.mock.calls.find(([arg]) => arg.action === "bulk_op.confirm");
    expect(confirmCall[0].metadata.scopeSummary.changed).toBe(2);
  });

  test("scope drift: a project deactivated after preview is flagged, not silently applied", async () => {
    seedProject("p1", { status: "paused" });
    seedProject("p2", { status: "paused" });
    const params = { filter: { status: "paused" }, reason: "quarterly cleanup" };
    const preview = await admin
      .post("/api/admin/bulk-ops/project_bulk_deactivate/preview")
      .send(params);

    // p2 gets deactivated out-of-band before confirm runs.
    pool.projects.get("p2").status = "inactive";
    pool.projects.get("p2").deactivated_at = new Date();

    const res = await admin
      .post(`/api/admin/bulk-ops/${preview.body.data.id}/confirm`)
      .send({ params, confirm: true });

    expect(res.status).toBe(200);
    const rows = res.body.data.outcomes.rows;
    expect(rows.find((r) => r.id === "p2")).toEqual({ id: "p2", outcome: "skipped", reason: "scope_drift_removed" });
    expect(rows.find((r) => r.id === "p1").outcome).toBe("changed");
  });

  test("partial failure surfaces a per-row failure without dropping other rows", async () => {
    seedProject("p1", { status: "paused" });
    seedProject("p2", { status: "paused", explode: true });
    const params = { filter: { status: "paused" }, reason: "quarterly cleanup" };
    const preview = await admin
      .post("/api/admin/bulk-ops/project_bulk_deactivate/preview")
      .send(params);

    const res = await admin
      .post(`/api/admin/bulk-ops/${preview.body.data.id}/confirm`)
      .send({ params, confirm: true });

    expect(res.status).toBe(207);
    expect(res.body.data.status).toBe("partial");
    const rows = res.body.data.outcomes.rows;
    expect(rows.find((r) => r.id === "p1").outcome).toBe("changed");
    expect(rows.find((r) => r.id === "p2").outcome).toBe("failed");
  });

  test("cancel expires a preview and prevents confirm", async () => {
    seedProject("p1", { status: "paused" });
    const params = { filter: { status: "paused" }, reason: "quarterly cleanup" };
    const preview = await admin
      .post("/api/admin/bulk-ops/project_bulk_deactivate/preview")
      .send(params);

    const cancelRes = await admin.post(`/api/admin/bulk-ops/${preview.body.data.id}/cancel`).send({});
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.data.status).toBe("cancelled");

    const confirmRes = await admin
      .post(`/api/admin/bulk-ops/${preview.body.data.id}/confirm`)
      .send({ params, confirm: true });
    expect(confirmRes.status).toBe(409);
    expect(pool.projects.get("p1").status).toBe("paused");
  });

  test("confirm rejects a tampered params payload", async () => {
    seedProject("p1", { status: "paused" });
    const params = { filter: { status: "paused" }, reason: "quarterly cleanup" };
    const preview = await admin
      .post("/api/admin/bulk-ops/project_bulk_deactivate/preview")
      .send(params);

    const res = await admin
      .post(`/api/admin/bulk-ops/${preview.body.data.id}/confirm`)
      .send({ params: { ...params, reason: "different reason" }, confirm: true });

    expect(res.status).toBe(400);
    expect(pool.projects.get("p1").status).toBe("paused");
  });

  test("GET / lists ops for review, including outcomes", async () => {
    seedProject("p1", { status: "paused" });
    const params = { filter: { status: "paused" }, reason: "quarterly cleanup" };
    const preview = await admin
      .post("/api/admin/bulk-ops/project_bulk_deactivate/preview")
      .send(params);
    await admin.post(`/api/admin/bulk-ops/${preview.body.data.id}/confirm`).send({ params, confirm: true });

    const res = await admin.get("/api/admin/bulk-ops?status=completed");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].outcomes.changed).toBe(1);
  });

  test("GET /:id returns full outcome detail", async () => {
    seedProject("p1", { status: "paused" });
    const params = { filter: { status: "paused" }, reason: "quarterly cleanup" };
    const preview = await admin
      .post("/api/admin/bulk-ops/project_bulk_deactivate/preview")
      .send(params);

    const res = await admin.get(`/api/admin/bulk-ops/${preview.body.data.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(preview.body.data.id);
  });
});
