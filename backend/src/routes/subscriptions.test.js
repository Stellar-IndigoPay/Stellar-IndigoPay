"use strict";

jest.mock("../db/pool", () => ({ query: jest.fn() }));

const express = require("express");
const request = require("supertest");
const pool = require("../db/pool");
const subscriptionsRouter = require("./subscriptions");
const { AppError } = require("../errors");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/subscriptions", subscriptionsRouter);
  app.use((err, _req, res, _next) => {
    if (err instanceof AppError) {
      return res.status(err.status).json(err.toJSON());
    }
    res.status(err.status || 500).json({ error: err.message });
  });
  return app;
}

describe("POST /api/subscriptions", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
  });

  test("returns 400 VALIDATION_ERROR when projectId is missing", async () => {
    const res = await request(app)
      .post("/api/subscriptions")
      .send({ email: "donor@example.com" })
      .expect(400);

    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.field).toBe("projectId");
  });

  test("returns 400 VALIDATION_ERROR for a malformed email", async () => {
    const res = await request(app)
      .post("/api/subscriptions")
      .send({ projectId: "project-1", email: "not-an-email" })
      .expect(400);

    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.field).toBe("email");
  });

  test("returns 404 PROJECT_NOT_FOUND when the project does not exist", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post("/api/subscriptions")
      .send({ projectId: "missing", email: "donor@example.com" })
      .expect(404);

    expect(res.body.error.code).toBe("PROJECT_NOT_FOUND");
  });

  test("returns 409 DUPLICATE_SUBSCRIPTION when already subscribed", async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: "project-1" }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .post("/api/subscriptions")
      .send({ projectId: "project-1", email: "donor@example.com" })
      .expect(409);

    expect(res.body.error.code).toBe("DUPLICATE_SUBSCRIPTION");
  });

  test("subscribes successfully", async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: "project-1" }] })
      .mockResolvedValueOnce({ rows: [{ id: "sub-1" }], rowCount: 1 });

    const res = await request(app)
      .post("/api/subscriptions")
      .send({ projectId: "project-1", email: "donor@example.com" })
      .expect(201);

    expect(res.body.success).toBe(true);
  });
});

describe("DELETE /api/subscriptions/:id", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
  });

  test("returns 400 VALIDATION_ERROR when neither email nor donorAddress is provided", async () => {
    const res = await request(app)
      .delete("/api/subscriptions/sub-1")
      .send({})
      .expect(400);

    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  test("returns 404 SUBSCRIPTION_NOT_FOUND when the row does not exist", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .delete("/api/subscriptions/missing")
      .send({ email: "donor@example.com" })
      .expect(404);

    expect(res.body.error.code).toBe("SUBSCRIPTION_NOT_FOUND");
  });

  test("returns 403 FORBIDDEN when the email/donorAddress does not match the record", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ email: "owner@example.com", donor_address: "GOWNER" }],
    });

    const res = await request(app)
      .delete("/api/subscriptions/sub-1")
      .send({ email: "stranger@example.com" })
      .expect(403);

    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  test("unsubscribes when the email matches", async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [{ email: "donor@example.com", donor_address: null }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .delete("/api/subscriptions/sub-1")
      .send({ email: "donor@example.com" })
      .expect(200);

    expect(res.body.success).toBe(true);
  });
});
