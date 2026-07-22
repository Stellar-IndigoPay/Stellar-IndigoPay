"use strict";

jest.mock("../db/pool", () => ({ query: jest.fn() }));

const express = require("express");
const request = require("supertest");
const pool = require("../db/pool");
const ratingsRouter = require("./ratings");
const { AppError } = require("../errors");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/ratings", ratingsRouter);
  app.use((err, _req, res, _next) => {
    if (err instanceof AppError) {
      return res.status(err.status).json(err.toJSON());
    }
    res.status(err.status || 500).json({ error: err.message });
  });
  return app;
}

describe("POST /api/ratings", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
  });

  test("returns 400 VALIDATION_ERROR when required fields are missing", async () => {
    const res = await request(app)
      .post("/api/ratings")
      .send({ projectId: "project-1" })
      .expect(400);

    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  test("returns 400 VALIDATION_ERROR when rating is out of range", async () => {
    const res = await request(app)
      .post("/api/ratings")
      .send({ projectId: "project-1", donorAddress: "GDONOR", rating: 9 })
      .expect(400);

    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.field).toBe("rating");
  });
});

describe("GET /api/ratings/pending", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
  });

  test("returns 400 VALIDATION_ERROR when donorAddress is missing", async () => {
    const res = await request(app).get("/api/ratings/pending").expect(400);

    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.field).toBe("donorAddress");
  });
});

describe("GET /api/ratings/project/:projectId", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
  });

  test("returns 404 PROJECT_NOT_FOUND when the project does not exist", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get("/api/ratings/project/missing")
      .expect(404);

    expect(res.body.error.code).toBe("PROJECT_NOT_FOUND");
  });

  test("returns 400 INVALID_CURSOR for a malformed cursor", async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: "project-1" }] });

    const res = await request(app)
      .get("/api/ratings/project/project-1?cursor=not-a-date")
      .expect(400);

    expect(res.body.error.code).toBe("INVALID_CURSOR");
  });
});
