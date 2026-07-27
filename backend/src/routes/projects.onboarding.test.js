"use strict";

jest.mock("../db/pool", () => ({
  query: jest.fn(),
  connect: jest.fn(),
}));

const express = require("express");
const request = require("supertest");
const pool = require("../db/pool");
const projects = require("./projects");
const { AppError } = require("../errors");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/projects", projects);
  app.use((err, _req, res, _next) => {
    if (err instanceof AppError) {
      return res.status(err.status).json(err.toJSON());
    }
    res.status(err.status || 500).json({ error: err.message });
  });
  return app;
}

describe("Project onboarding checklist API", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
  });

  test("GET /api/projects/:id/onboarding returns checklist items", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [
        {
          items: [
            { key: "verify_wallet", label: "Verify wallet ownership", completed: false },
          ],
        },
      ],
    });

    const res = await request(app).get("/api/projects/123/onboarding");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].key).toBe("verify_wallet");
  });

  test("PATCH /api/projects/:id/onboarding/:key marks item completed", async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [
          {
            items: [
              { key: "verify_wallet", label: "Verify wallet ownership", completed: false },
              { key: "configure_webhook", label: "Configure webhook endpoint", completed: false },
            ],
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app).patch(
      "/api/projects/123/onboarding/verify_wallet",
    );
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.find((item) => item.key === "verify_wallet").completed).toBe(true);
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  test("PATCH returns PROJECT_NOT_FOUND when no onboarding data exists", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).patch(
      "/api/projects/123/onboarding/verify_wallet",
    );
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("PROJECT_NOT_FOUND");
  });
});
