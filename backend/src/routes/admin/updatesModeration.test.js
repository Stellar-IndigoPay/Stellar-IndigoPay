"use strict";

/**
 * routes/admin/updatesModeration.test.js
 *
 * Admin review queue for project-update moderation (issue #935):
 *   GET  /              queue, filterable by moderation status
 *   GET  /:id           detail with screening trail + abuse reports
 *   POST /:id/decide    approve | quarantine | remove (via decideModeration)
 */

jest.mock("../../db/pool", () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock("../../services/moderation", () => ({
  decideModeration: jest.fn(),
}));

const { decideModeration } = require("../../services/moderation");

const express = require("express");
const request = require("supertest");
const pool = require("../../db/pool");

const UPDATE_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/admin/updates/moderation", require("./updatesModeration"));
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message || "Internal server error" });
  });
  return app;
}

process.env.ADMIN_API_KEY = "test-admin-key";

function updateRow(overrides = {}) {
  return {
    id: UPDATE_ID,
    project_id: PROJECT_ID,
    title: "Suspicious payout offer",
    body: "Make $5000 a day guaranteed profit.",
    created_at: "2026-07-01T00:00:00.000Z",
    moderation_status: "quarantined",
    moderation_screening: {
      rules: { decision: "review", ruleHits: [{ rule: "spam.buzz_phrase" }] },
      ai: { verdict: "spam", confidence: 0.9, rationale: "Payout spam." },
    },
    moderation_screened_at: "2026-07-01T00:01:00.000Z",
    moderation_reviewed_by: null,
    moderation_reviewed_at: null,
    moderation_rationale: null,
    moderation_alerted: true,
    project_name: "Mangrove Restoration",
    abuse_report_count: 2,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("admin review queue", () => {
  test("requires staff auth", async () => {
    const app = buildApp();
    const res = await request(app).get("/api/admin/updates/moderation");
    expect(res.status).toBe(401);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test("defaults the queue to pending + quarantined", async () => {
    const app = buildApp();
    pool.query.mockResolvedValueOnce({ rows: [updateRow()] });

    const res = await request(app)
      .get("/api/admin/updates/moderation")
      .set("X-Admin-Key", "test-admin-key");

    expect(res.status).toBe(200);
    expect(pool.query.mock.calls[0][0]).toContain(
      "pu.moderation_status IN ('pending-screening', 'quarantined')",
    );
    expect(res.body.data[0]).toEqual(
      expect.objectContaining({
        id: UPDATE_ID,
        moderationStatus: "quarantined",
        moderationRationale: null,
        projectName: "Mangrove Restoration",
        abuseReportCount: 2,
      }),
    );
  });

  test("filters by an explicit moderation status", async () => {
    const app = buildApp();
    pool.query.mockResolvedValueOnce({ rows: [updateRow({ moderation_status: "live" })] });

    const res = await request(app)
      .get("/api/admin/updates/moderation")
      .query({ status: "live" })
      .set("X-Admin-Key", "test-admin-key");

    expect(res.status).toBe(200);
    expect(pool.query.mock.calls[0][0]).toContain("ANY");
    expect(res.body.data[0].moderationStatus).toBe("live");
  });

  test("rejects an invalid status filter", async () => {
    const app = buildApp();
    const res = await request(app)
      .get("/api/admin/updates/moderation")
      .query({ status: "definitely-not-a-status" })
      .set("X-Admin-Key", "test-admin-key");

    expect(res.status).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test("returns update detail with the full screening trail and reports", async () => {
    const app = buildApp();
    pool.query
      .mockResolvedValueOnce({ rows: [updateRow()] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "r1",
            reporter: "admin-key",
            reason: "Phishing",
            has_ip: true,
            created_at: "2026-07-01T00:05:00.000Z",
          },
        ],
      });

    const res = await request(app)
      .get(`/api/admin/updates/moderation/${UPDATE_ID}`)
      .set("X-Admin-Key", "test-admin-key");

    expect(res.status).toBe(200);
    expect(res.body.data.moderationScreening.ai.verdict).toBe("spam");
    expect(res.body.data.abuseReports).toHaveLength(1);
    // The raw IP is never exposed — only whether one was captured.
    expect(res.body.data.abuseReports[0].has_ip).toBe(true);
    expect(res.body.data.abuseReports[0].ip_hash).toBeUndefined();
  });

  test("404 for an unknown update in the detail view", async () => {
    const app = buildApp();
    pool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get(`/api/admin/updates/moderation/${UPDATE_ID}`)
      .set("X-Admin-Key", "test-admin-key");

    expect(res.status).toBe(404);
  });
});

describe("POST /:id/decide", () => {
  test("approve routes through decideModeration and returns the result", async () => {
    const app = buildApp();
    decideModeration.mockResolvedValueOnce({
      okay: true,
      status: "live",
      update: {
        ...updateRow({ moderation_status: "live" }),
        moderationStatus: "live",
      },
    });

    const res = await request(app)
      .post(`/api/admin/updates/moderation/${UPDATE_ID}/decide`)
      .set("X-Admin-Key", "test-admin-key")
      .send({ decision: "approve", rationale: "False positive" });

    expect(res.status).toBe(200);
    expect(res.body.data.moderationStatus).toBe("live");
    expect(decideModeration).toHaveBeenCalledWith(
      expect.objectContaining({
        updateId: UPDATE_ID,
        decision: "approve",
        reviewer: "admin-key",
        rationale: "False positive",
      }),
    );
  });

  test("remove is a valid terminal decision", async () => {
    const app = buildApp();
    decideModeration.mockResolvedValueOnce({
      okay: true,
      status: "removed",
      update: {
        ...updateRow({ moderation_status: "removed" }),
        moderationStatus: "removed",
      },
    });

    const res = await request(app)
      .post(`/api/admin/updates/moderation/${UPDATE_ID}/decide`)
      .set("X-Admin-Key", "test-admin-key")
      .send({ decision: "remove", rationale: "Terms violation" });

    expect(res.status).toBe(200);
    expect(res.body.data.moderationStatus).toBe("removed");
  });

  test("rejects an unknown decision", async () => {
    const app = buildApp();
    const res = await request(app)
      .post(`/api/admin/updates/moderation/${UPDATE_ID}/decide`)
      .set("X-Admin-Key", "test-admin-key")
      .send({ decision: "unpublish-all-of-it" });

    expect(res.status).toBe(400);
    expect(decideModeration).not.toHaveBeenCalled();
  });

  test("maps update_not_found to 404", async () => {
    const app = buildApp();
    decideModeration.mockResolvedValueOnce({ okay: false, error: "update_not_found" });

    const res = await request(app)
      .post(`/api/admin/updates/moderation/${UPDATE_ID}/decide`)
      .set("X-Admin-Key", "test-admin-key")
      .send({ decision: "quarantine" });

    expect(res.status).toBe(404);
  });

  test("maps a failed decision to 400", async () => {
    const app = buildApp();
    decideModeration.mockResolvedValueOnce({ okay: false, error: "decision_failed" });

    const res = await request(app)
      .post(`/api/admin/updates/moderation/${UPDATE_ID}/decide`)
      .set("X-Admin-Key", "test-admin-key")
      .send({ decision: "quarantine" });

    expect(res.status).toBe(400);
  });
});