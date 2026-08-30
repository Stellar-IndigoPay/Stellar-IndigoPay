"use strict";

/**
 * routes/updates.moderation.test.js
 *
 * Content-moderation behaviour wired into the updates API (issue #935):
 *   - submissions are screened inline; hard hits auto-quarantine + alert,
 *     soft hits go pending (background AI decides), clean hits go live.
 *   - notifications only ever fire for live content.
 *   - the public read path filters moderation_status = 'live'.
 *   - the staff-only abuse-report endpoint quarantines live updates.
 */

jest.mock("../db/pool", () => ({ query: jest.fn() }));
jest.mock("../services/email", () => ({
  sendUpdateNotifications: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../services/pushQueue", () => ({
  enqueuePushNotification: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../services/audit", () => ({
  logAdminAction: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../services/moderation", () => ({
  screenProjectUpdate: jest.fn().mockResolvedValue({ outcome: "live" }),
  raiseModerationAlert: jest.fn().mockResolvedValue(undefined),
}));

process.env.ADMIN_API_KEY = "test-admin-key";

const express = require("express");
const request = require("supertest");
const pool = require("../db/pool");
const { enqueuePushNotification } = require("../services/pushQueue");
const { logAdminAction } = require("../services/audit");
const {
  screenProjectUpdate,
  raiseModerationAlert,
} = require("../services/moderation");

const UPDATE_ID = "33333333-3333-4333-8333-333333333333";
const PROJECT_ID = "44444444-4444-4444-8444-444444444444";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/updates", require("./updates"));
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message || "Internal server error" });
  });
  return app;
}

function projectRow() {
  return { id: PROJECT_ID, name: "Mangrove Restoration" };
}

function updateRow(overrides = {}) {
  return {
    id: UPDATE_ID,
    project_id: PROJECT_ID,
    title: "We planted 500 trees!",
    body: "Big milestone for the grove.",
    created_at: "2026-07-01T00:00:00.000Z",
    moderation_status: "live",
    moderation_screening: null,
    moderation_screened_at: null,
    moderation_reviewed_by: null,
    moderation_reviewed_at: null,
    moderation_rationale: null,
    moderation_alerted: false,
    ...overrides,
  };
}

const HARD_BODY = "Connect your wallet at http://10.0.0.1/verify";
const SOFT_BODY = "Make $5000 a day guaranteed profit no risk.";

beforeEach(() => {
  jest.clearAllMocks();
});

describe("POST /api/updates — moderation gates", () => {
  let app;
  beforeEach(() => {
    app = buildApp();
  });

  test("clean submissions go live and notify subscribers", async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [projectRow()] })
      .mockResolvedValueOnce({ rows: [updateRow()] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post("/api/updates")
      .set("X-Admin-Key", "test-admin-key")
      .send({ projectId: PROJECT_ID, title: "We planted 500 trees!", body: "Big milestone for the grove." });

    expect(res.status).toBe(201);
    expect(res.body.data.moderationStatus).toBe("live");
    expect(enqueuePushNotification).toHaveBeenCalled();
    const insertCall = pool.query.mock.calls.find(([sql]) =>
      sql.includes("INSERT INTO project_updates"),
    );
    expect(insertCall[1][4]).toBe("live");
  });

  test("hard rule violations auto-quarantine without notifying anyone", async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [projectRow()] })
      .mockResolvedValueOnce({ rows: [updateRow({ moderation_status: "quarantined" })] });

    const res = await request(app)
      .post("/api/updates")
      .set("X-Admin-Key", "test-admin-key")
      .send({ projectId: PROJECT_ID, title: "Bonus", body: HARD_BODY });

    expect(res.status).toBe(201);
    expect(res.body.data.moderationStatus).toBe("quarantined");
    expect(enqueuePushNotification).not.toHaveBeenCalled();
    expect(raiseModerationAlert).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "rule_hard_violation", updateId: expect.any(String) }),
    );
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "update.auto_quarantined" }),
    );
    const insertCall = pool.query.mock.calls.find(([sql]) =>
      sql.includes("INSERT INTO project_updates"),
    );
    expect(insertCall[1][4]).toBe("quarantined");
  });

  test("soft signals go pending and hand off to the background screener", async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [projectRow()] })
      .mockResolvedValueOnce({ rows: [updateRow({ moderation_status: "pending-screening" })] });

    const res = await request(app)
      .post("/api/updates")
      .set("X-Admin-Key", "test-admin-key")
      .send({ projectId: PROJECT_ID, title: "Urgent", body: SOFT_BODY });

    expect(res.status).toBe(201);
    expect(res.body.data.moderationStatus).toBe("pending-screening");
    expect(enqueuePushNotification).not.toHaveBeenCalled();
    expect(screenProjectUpdate).toHaveBeenCalledTimes(1);
    const args = screenProjectUpdate.mock.calls[0][0];
    expect(args.updateId).toEqual(expect.any(String));
    expect(typeof args.onLive).toBe("function");
  });

  test("non-live content still rejects the push path silently", async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [projectRow()] })
      .mockResolvedValueOnce({ rows: [updateRow({ moderation_status: "pending-screening" })] });

    await request(app)
      .post("/api/updates")
      .set("X-Admin-Key", "test-admin-key")
      .send({ projectId: PROJECT_ID, title: "Urgent", body: SOFT_BODY });

    expect(enqueuePushNotification).not.toHaveBeenCalled();
  });
});

describe("GET /api/updates/:projectId — live-only scroll", () => {
  let app;
  beforeEach(() => {
    app = buildApp();
  });

  test("adds the moderation filter to the read query", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [updateRow()],
    });

    const res = await request(app).get(`/api/updates/${PROJECT_ID}`);

    expect(res.status).toBe(200);
    expect(pool.query.mock.calls[0][0]).toContain("moderation_status = 'live'");
    expect(res.body.data[0].moderationStatus).toBe("live");
  });
});

describe("POST /api/updates/:updateId/report — staff abuse report", () => {
  let app;
  beforeEach(() => {
    app = buildApp();
  });

  test("requires staff auth", async () => {
    const res = await request(app)
      .post(`/api/updates/${UPDATE_ID}/report`)
      .send({ reason: "Scam" });

    expect(res.status).toBe(401);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test("rejects a missing reason", async () => {
    const res = await request(app)
      .post(`/api/updates/${UPDATE_ID}/report`)
      .set("X-Admin-Key", "test-admin-key")
      .send({});

    expect(res.status).toBe(400);
  });

  test("reports a missing update as 404", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post(`/api/updates/${UPDATE_ID}/report`)
      .set("X-Admin-Key", "test-admin-key")
      .send({ reason: "Scam links" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Update not found");
  });

  test("quarantines a live update and records the report", async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [updateRow()] }) // find update
      .mockResolvedValueOnce({ rows: [] }) // insert report (ON CONFLICT)
      .mockResolvedValueOnce({
        rows: [updateRow({ moderation_status: "quarantined" })],
      }); // quarantine update

    const res = await request(app)
      .post(`/api/updates/${UPDATE_ID}/report`)
      .set("X-Admin-Key", "test-admin-key")
      .send({ reason: "Phishing link in body" });

    expect(res.status).toBe(202);
    expect(res.body.data.moderationStatus).toBe("quarantined");
    expect(raiseModerationAlert).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "staff_abuse_report", updateId: UPDATE_ID }),
    );
    // The report row stores a hashed IP, never the raw value.
    const reportCall = pool.query.mock.calls.find(([sql]) =>
      sql.includes("INSERT INTO update_abuse_reports"),
    );
    expect(reportCall[1][2]).toBe("admin-key");
    expect(reportCall[1][4]).toMatch(/^[0-9a-f]{64}$/);
  });

  test("an already-quarantined update just accumulates the report", async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [updateRow({ moderation_status: "quarantined" })] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post(`/api/updates/${UPDATE_ID}/report`)
      .set("X-Admin-Key", "test-admin-key")
      .send({ reason: "Still bad" });

    expect(res.status).toBe(200);
    expect(res.body.data.moderationStatus).toBe("quarantined");
    expect(raiseModerationAlert).not.toHaveBeenCalled();
  });

  test("a removed update is returned unchanged, terminal state honoured", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [updateRow({ moderation_status: "removed" })],
    });

    const res = await request(app)
      .post(`/api/updates/${UPDATE_ID}/report`)
      .set("X-Admin-Key", "test-admin-key")
      .send({ reason: "Appeal?" });

    expect(res.status).toBe(200);
    expect(res.body.data.moderationStatus).toBe("removed");
    expect(pool.query).toHaveBeenCalledTimes(1);
  });
});