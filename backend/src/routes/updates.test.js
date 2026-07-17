"use strict";

jest.mock("../db/pool", () => ({ query: jest.fn() }));
jest.mock("../services/email", () => ({
  sendUpdateNotifications: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../services/pushQueue", () => ({
  enqueuePushNotification: jest.fn().mockResolvedValue(undefined),
}));

process.env.ADMIN_API_KEY = "test-admin-key";

const express = require("express");
const request = require("supertest");
const pool = require("../db/pool");
const updatesRouter = require("./updates");
const { AppError } = require("../errors");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/updates", updatesRouter);
  app.use((err, _req, res, _next) => {
    if (err instanceof AppError) {
      return res.status(err.status).json(err.toJSON());
    }
    res.status(err.status || 500).json({ error: err.message });
  });
  return app;
}

describe("GET /api/updates/:projectId", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
  });

  test("returns 400 INVALID_CURSOR for a malformed cursor", async () => {
    const res = await request(app)
      .get("/api/updates/project-1?cursor=not-base64-json")
      .expect(400);

    expect(res.body.error.code).toBe("INVALID_CURSOR");
  });
});

describe("POST /api/updates", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
  });

  test("returns 400 VALIDATION_ERROR when title is missing", async () => {
    const res = await request(app)
      .post("/api/updates")
      .set("X-Admin-Key", "test-admin-key")
      .send({ projectId: "project-1", body: "text" })
      .expect(400);

    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.field).toBe("title");
  });

  test("returns 404 PROJECT_NOT_FOUND when the project does not exist", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post("/api/updates")
      .set("X-Admin-Key", "test-admin-key")
      .send({ projectId: "missing", title: "t", body: "b" })
      .expect(404);

    expect(res.body.error.code).toBe("PROJECT_NOT_FOUND");
  });
});

describe("POST /api/updates/:updateId/like", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
  });

  test("returns 400 VALIDATION_ERROR when donorAddress is missing", async () => {
    const res = await request(app)
      .post("/api/updates/update-1/like")
      .send({})
      .expect(400);

    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.field).toBe("donorAddress");
  });

  test("returns 404 UPDATE_NOT_FOUND when the update does not exist", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post("/api/updates/missing/like")
      .send({ donorAddress: "GDONOR" })
      .expect(404);

    expect(res.body.error.code).toBe("UPDATE_NOT_FOUND");
  });
});
