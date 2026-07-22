"use strict";

jest.mock("../db/pool", () => ({
  query: jest.fn(),
  connect: jest.fn(),
}));

const express = require("express");
const request = require("supertest");
const pool = require("../db/pool");
const notificationsRouter = require("./notifications");
const { AppError } = require("../errors");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/notifications", notificationsRouter);
  app.use((err, _req, res, _next) => {
    if (err instanceof AppError) {
      return res.status(err.status).json(err.toJSON());
    }
    res
      .status(err.status || 500)
      .json({ error: err.message || "Internal server error" });
  });
  return app;
}

describe("GET /api/notifications/unread-count", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
  });

  test("returns unreadCount for followed project updates newer than lastSeen", async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: "device-token-id" }] })
      .mockResolvedValueOnce({ rows: [{ unread_count: "3" }] });

    const lastSeen = "2026-06-30T08:00:00.000Z";
    const res = await request(app)
      .get("/api/notifications/unread-count")
      .query({ token: "ExponentPushToken[abc]", lastSeen })
      .expect(200);

    expect(res.body).toEqual({ unreadCount: 3 });
    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      "SELECT id FROM device_tokens WHERE token = $1",
      ["ExponentPushToken[abc]"],
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("pu.created_at > $2"),
      ["device-token-id", lastSeen],
    );
  });

  test("counts all followed project updates when lastSeen is omitted", async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: "device-token-id" }] })
      .mockResolvedValueOnce({ rows: [{ unread_count: "7" }] });

    const res = await request(app)
      .get("/api/notifications/unread-count")
      .query({ token: "ExponentPushToken[abc]" })
      .expect(200);

    expect(res.body).toEqual({ unreadCount: 7 });
    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.not.stringContaining("pu.created_at >"),
      ["device-token-id"],
    );
  });

  test("rejects requests without a token", async () => {
    const res = await request(app)
      .get("/api/notifications/unread-count")
      .expect(400);

    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.field).toBe("token");
    expect(pool.query).not.toHaveBeenCalled();
  });

  test("rejects invalid lastSeen timestamps", async () => {
    const res = await request(app)
      .get("/api/notifications/unread-count")
      .query({ token: "ExponentPushToken[abc]", lastSeen: "not-a-date" })
      .expect(400);

    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.field).toBe("lastSeen");
    expect(pool.query).not.toHaveBeenCalled();
  });

  test("returns 404 when the device token is not registered", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get("/api/notifications/unread-count")
      .query({ token: "ExponentPushToken[missing]" })
      .expect(404);

    expect(res.body.error.code).toBe("DEVICE_TOKEN_NOT_FOUND");
    expect(pool.query).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/notifications/preferences", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
  });

  test("returns preferences and DND for a wallet", async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [
          { type: "donation_receipt", enabled: true, channel: "push" },
          { type: "milestone_reached", enabled: false, channel: "push" },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ notification_dnd: { start: "22:00", end: "08:00", timezone: "UTC" } }],
      });

    const res = await request(app)
      .get("/api/notifications/preferences")
      .query({ walletAddress: "GDONOR" })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.walletAddress).toBe("GDONOR");
    expect(res.body.data.preferences).toEqual({
      donation_receipt: true,
      milestone_reached: false,
    });
    expect(res.body.data.dnd).toEqual({
      start: "22:00",
      end: "08:00",
      timezone: "UTC",
    });
  });

  test("returns empty preferences and null DND when nothing is configured", async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get("/api/notifications/preferences")
      .query({ walletAddress: "GNEWUSER" })
      .expect(200);

    expect(res.body.data.preferences).toEqual({});
    expect(res.body.data.dnd).toBeNull();
  });

  test("rejects requests without walletAddress", async () => {
    const res = await request(app)
      .get("/api/notifications/preferences")
      .expect(400);

    expect(res.body.error).toBe(
      "walletAddress query parameter is required",
    );
  });
});

describe("PUT /api/notifications/preferences", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
    // The PUT handler uses a client with BEGIN/COMMIT
    const mockClient = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
      release: jest.fn(),
    };
    pool.connect.mockResolvedValue(mockClient);
  });

  test("upserts category preferences and DND", async () => {
    const res = await request(app)
      .put("/api/notifications/preferences")
      .send({
        walletAddress: "GDONOR",
        preferences: { donation_receipt: true, project_update: false },
        dnd: { start: "22:00", end: "08:00", timezone: "America/New_York" },
      })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.walletAddress).toBe("GDONOR");
  });

  test("rejects when walletAddress is missing", async () => {
    const res = await request(app)
      .put("/api/notifications/preferences")
      .send({ preferences: { donation_receipt: true } })
      .expect(400);

    expect(res.body.error).toBe("walletAddress is required");
  });

  test("rejects when preferences object is missing", async () => {
    const res = await request(app)
      .put("/api/notifications/preferences")
      .send({ walletAddress: "GDONOR" })
      .expect(400);

    expect(res.body.error).toBe("preferences object is required");
  });
});

describe("POST /api/notifications/unregister", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
  });

  test("marks a token as inactive", async () => {
    pool.query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: "token-id-123" }],
    });

    const res = await request(app)
      .post("/api/notifications/unregister")
      .send({ token: "ExponentPushToken[stale]" })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.tokenId).toBe("token-id-123");
    expect(res.body.data.active).toBe(false);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("SET is_active = false"),
      ["ExponentPushToken[stale]"],
    );
  });

  test("returns 404 when the token is not registered", async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const res = await request(app)
      .post("/api/notifications/unregister")
      .send({ token: "ExponentPushToken[unknown]" })
      .expect(404);

    expect(res.body.error).toBe("Device token not found");
  });

  test("rejects requests without a token", async () => {
    const res = await request(app)
      .post("/api/notifications/unregister")
      .send({})
      .expect(400);

    expect(res.body.error).toBe("token is required");
  });
});

describe("PATCH /api/notifications/preferences", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
  });

  test("upserts a project-level preference", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .patch("/api/notifications/preferences")
      .send({
        walletAddress: "GDONOR",
        projectId: "proj-1",
        channel: "push",
        enabled: true,
      })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.walletAddress).toBe("GDONOR");
    expect(res.body.data.projectId).toBe("proj-1");
    expect(res.body.data.enabled).toBe(true);
  });

  test("rejects missing required fields", async () => {
    const res = await request(app)
      .patch("/api/notifications/preferences")
      .send({ walletAddress: "GDONOR" })
      .expect(400);

    expect(res.body.error).toBe("projectId is required");
  });
});

describe("GET /api/notifications/inbox", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
  });

  test("returns paginated in-app notifications for a wallet", async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [
          { id: "n1", title: "Test", body: "Body", data: {}, read: false, created_at: new Date().toISOString() },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ total: "1" }] })
      .mockResolvedValueOnce({ rows: [{ unread: "1" }] });

    const res = await request(app)
      .get("/api/notifications/inbox")
      .query({ walletAddress: "GDONOR" })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.notifications).toHaveLength(1);
    expect(res.body.data.total).toBe(1);
    expect(res.body.data.unread).toBe(1);
  });

  test("rejects requests without walletAddress", async () => {
    const res = await request(app)
      .get("/api/notifications/inbox")
      .expect(400);

    expect(res.body.error).toBe("walletAddress query parameter is required");
  });
});

describe("POST /api/notifications/inbox/:id/read", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
  });

  test("marks an in-app notification as read", async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "n1", read: true }] });

    const res = await request(app)
      .post("/api/notifications/inbox/n1/read")
      .send({ walletAddress: "GDONOR" })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.read).toBe(true);
  });

  test("returns 404 when notification is not found", async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const res = await request(app)
      .post("/api/notifications/inbox/n1/read")
      .send({ walletAddress: "GDONOR" })
      .expect(404);

    expect(res.body.error).toBe("Notification not found");
  });

  test("rejects requests without walletAddress", async () => {
    const res = await request(app)
      .post("/api/notifications/inbox/n1/read")
      .send({})
      .expect(400);

    expect(res.body.error).toBe("walletAddress is required in body");
  });
});
