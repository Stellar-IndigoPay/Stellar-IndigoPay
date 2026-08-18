"use strict";

jest.mock("../db/pool", () => ({ query: jest.fn() }));

const express = require("express");
const request = require("supertest");
const pool = require("../db/pool");
const jobsRouter = require("./jobs");
const { AppError } = require("../errors");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/jobs", jobsRouter);
  app.use((err, _req, res, _next) => {
    if (err instanceof AppError) {
      return res.status(err.status).json(err.toJSON());
    }
    res.status(err.status || 500).json({ error: err.message });
  });
  return app;
}

const MOCK_JOB_ROW = {
  id: "22222222-2222-4222-8222-222222222222",
  status: "in_escrow",
  client_public_key: "GCLIENT",
  created_at: "2026-01-01T00:00:00.000Z",
};

describe("GET /api/jobs", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
  });

  test("lists jobs", async () => {
    pool.query.mockResolvedValueOnce({ rows: [MOCK_JOB_ROW] });

    const res = await request(app).get("/api/jobs").expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);
  });
});

describe("GET /api/jobs/:id", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
  });

  test("returns 404 with JOB_NOT_FOUND when the job does not exist", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get("/api/jobs/44444444-4444-4444-8444-444444444444")
      .expect(404);
    expect(res.body.error.code).toBe("JOB_NOT_FOUND");
  });

  test("returns 400 before querying for a malformed job ID", async () => {
    const res = await request(app).get("/api/jobs/not-a-uuid").expect(400);

    expect(res.body.error).toBe("Validation failed");
    expect(res.body.details).toContainEqual({
      path: "id",
      message: "Invalid UUID",
    });
    expect(pool.query).not.toHaveBeenCalled();
  });

  test("returns the job when found", async () => {
    pool.query.mockResolvedValueOnce({ rows: [MOCK_JOB_ROW] });

    const res = await request(app)
      .get("/api/jobs/22222222-2222-4222-8222-222222222222")
      .expect(200);
    expect(res.body.data.id).toBe("22222222-2222-4222-8222-222222222222");
  });
});

describe("PATCH /api/jobs/:id/release", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
  });

  const validHash = "a".repeat(64);

  test("returns 400 INVALID_TX_HASH for a malformed transaction hash", async () => {
    const res = await request(app)
      .patch("/api/jobs/22222222-2222-4222-8222-222222222222/release")
      .send({ releaseTransactionHash: "bad-hash" })
      .expect(400);

    expect(res.body.error.code).toBe("INVALID_TX_HASH");
    expect(pool.query).not.toHaveBeenCalled();
  });

  test("returns 404 JOB_NOT_FOUND when the job does not exist", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .patch("/api/jobs/44444444-4444-4444-8444-444444444444/release")
      .send({ releaseTransactionHash: validHash })
      .expect(404);

    expect(res.body.error.code).toBe("JOB_NOT_FOUND");
  });

  test("returns 400 VALIDATION_ERROR when the job is not in escrow", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ ...MOCK_JOB_ROW, status: "completed" }],
    });

    const res = await request(app)
      .patch("/api/jobs/22222222-2222-4222-8222-222222222222/release")
      .send({ releaseTransactionHash: validHash })
      .expect(400);

    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.detail).toBe("Job is not awaiting release");
  });

  test("releases the job when in escrow with a valid hash", async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [MOCK_JOB_ROW] })
      .mockResolvedValueOnce({
        rows: [
          {
            ...MOCK_JOB_ROW,
            status: "completed",
            release_transaction_hash: validHash,
          },
        ],
      });

    const res = await request(app)
      .patch("/api/jobs/22222222-2222-4222-8222-222222222222/release")
      .send({ releaseTransactionHash: validHash })
      .expect(200);

    expect(res.body.data.status).toBe("completed");
  });
});
