"use strict";

jest.mock("../db/pool", () => ({ query: jest.fn() }));
jest.mock("../services/cache", () => ({
  get: jest.fn(() => null),
  set: jest.fn(),
}));

const express = require("express");
const request = require("supertest");
const pool = require("../db/pool");
const impactRouter = require("./impact");
const { AppError } = require("../errors");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/impact", impactRouter);
  app.use((err, _req, res, _next) => {
    if (err instanceof AppError) {
      return res.status(err.status).json(err.toJSON());
    }
    res.status(err.status || 500).json({ error: err.message });
  });
  return app;
}

function makePublicKey(char = "A") {
  return `G${char.repeat(55)}`;
}

describe("GET /api/impact/project/:id", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
  });

  test("returns 404 PROJECT_NOT_FOUND when the project does not exist", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get("/api/impact/project/missing")
      .expect(404);

    expect(res.body.error.code).toBe("PROJECT_NOT_FOUND");
  });
});

describe("GET /api/impact/donor/:publicKey", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
  });

  test("returns 400 INVALID_ADDRESS for a malformed public key", async () => {
    const res = await request(app)
      .get("/api/impact/donor/not-a-key")
      .expect(400);

    expect(res.body.error.code).toBe("INVALID_ADDRESS");
    expect(pool.query).not.toHaveBeenCalled();
  });

  test("returns donor impact for a valid public key", async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [
          {
            totalDonatedXLM: "100",
            projectsSupported: 2,
            co2OffsetKg: "50",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ category: "Reforestation" }] });

    const res = await request(app)
      .get(`/api/impact/donor/${makePublicKey()}`)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.topCategory).toBe("Reforestation");
  });
});
