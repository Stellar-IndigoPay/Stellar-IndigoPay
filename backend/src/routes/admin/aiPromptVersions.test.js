"use strict";

const express = require("express");
const request = require("supertest");

const mockConnect = jest.fn();
jest.mock("../../db/pool", () => ({
  query: jest.fn(),
  connect: (...args) => mockConnect(...args),
}));

jest.mock("../../middleware/rateLimiter", () => ({
  createRateLimiter: () => (req, res, next) => next(),
}));

jest.mock("../../services/audit", () => ({
  logAdminAction: jest.fn().mockResolvedValue(undefined),
}));

const pool = require("../../db/pool");
const { logAdminAction } = require("../../services/audit");

process.env.ADMIN_USERNAME = "admin";
process.env.ADMIN_PASSWORD = "testpass";
process.env.ADMIN_API_KEY = "test-admin-key";
process.env.JWT_SECRET = "test-secret-for-jest";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/admin/ai-prompt-versions", require("./aiPromptVersions"));
  return app;
}

function fakeClient(rows) {
  return {
    query: jest.fn().mockImplementation((sql) => {
      if (sql.startsWith("BEGIN") || sql.startsWith("COMMIT") || sql.startsWith("ROLLBACK")) {
        return Promise.resolve();
      }
      if (sql.startsWith("UPDATE prompt_versions")) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows });
    }),
    release: jest.fn(),
  };
}

describe("Admin AI Prompt Versions Router", () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  test("GET / returns 401 without auth", async () => {
    const res = await request(app).get("/api/admin/ai-prompt-versions");
    expect(res.status).toBe(401);
  });

  test("GET / lists versions with valid X-Admin-Key", async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: "1", slug: "v1", active: true }] });

    const res = await request(app)
      .get("/api/admin/ai-prompt-versions")
      .set("X-Admin-Key", "test-admin-key");

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  test("POST / rejects a missing body field", async () => {
    const res = await request(app)
      .post("/api/admin/ai-prompt-versions")
      .set("X-Admin-Key", "test-admin-key")
      .send({ slug: "v2" });

    expect(res.status).toBe(400);
  });

  test("POST / creates and activates a new version, deactivating the old one, and audits it", async () => {
    const client = fakeClient([
      { id: "new-id", slug: "v2", model: "claude-opus-4-7", active: true },
    ]);
    mockConnect.mockResolvedValueOnce(client);

    const res = await request(app)
      .post("/api/admin/ai-prompt-versions")
      .set("X-Admin-Key", "test-admin-key")
      .send({ slug: "v2", body: "New system prompt.", model: "claude-opus-4-7" });

    expect(res.status).toBe(201);
    expect(res.body.data.slug).toBe("v2");

    // Deactivate-old, insert-new, all inside BEGIN/COMMIT.
    const calledSql = client.query.mock.calls.map((c) => c[0]);
    expect(calledSql[0]).toBe("BEGIN");
    expect(calledSql.some((sql) => sql.includes("UPDATE prompt_versions SET active = FALSE"))).toBe(true);
    expect(calledSql.some((sql) => sql.includes("INSERT INTO prompt_versions"))).toBe(true);
    expect(calledSql[calledSql.length - 1]).toBe("COMMIT");

    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ai_prompt_version.activated" }),
    );
    expect(client.release).toHaveBeenCalled();
  });

  test("POST / rolls back and returns a validation error on a duplicate slug", async () => {
    const client = fakeClient([]);
    client.query.mockImplementation((sql) => {
      if (sql.startsWith("BEGIN")) return Promise.resolve();
      if (sql.startsWith("UPDATE prompt_versions")) return Promise.resolve({ rows: [] });
      if (sql.startsWith("INSERT INTO prompt_versions")) {
        const err = new Error("duplicate key value violates unique constraint");
        err.code = "23505";
        return Promise.reject(err);
      }
      if (sql.startsWith("ROLLBACK")) return Promise.resolve();
      return Promise.resolve({ rows: [] });
    });
    mockConnect.mockResolvedValueOnce(client);

    const res = await request(app)
      .post("/api/admin/ai-prompt-versions")
      .set("X-Admin-Key", "test-admin-key")
      .send({ slug: "v1", body: "New system prompt.", model: "claude-opus-4-7" });

    expect(res.status).toBe(400);
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.release).toHaveBeenCalled();
  });
});
