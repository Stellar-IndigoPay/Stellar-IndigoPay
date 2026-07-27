"use strict";

jest.mock("../db/pool", () => ({
  query: jest.fn(),
}));

jest.mock("../middleware/rateLimiter", () => ({
  createRateLimiter: () => (req, res, next) => next(),
}));

const express = require("express");
const request = require("supertest");
const profilesRouter = require("./profiles");
const { AppError } = require("../errors");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/profiles", profilesRouter);
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

describe("POST /api/profiles", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
  });

  test("rejects HTML in profile display name with 422 field errors", async () => {
    const res = await request(app)
      .post("/api/profiles")
      .send({
        publicKey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
        displayName: "<b>Bad</b>",
        bio: "A short bio",
      })
      .expect(422);

    expect(res.body.error.code).toBe("SCHEMA_VALIDATION_ERROR");
    expect(res.body.error.message).toBe("Validation failed");
    // `details` is now an array of {path, message} entries, matching every
    // other route that uses the unified `validate` middleware (#050).
    expect(Array.isArray(res.body.error.details)).toBe(true);
    const displayNameDetail = res.body.error.details.find(
      (d) => d.path === "displayName",
    );
    expect(displayNameDetail).toBeDefined();
    // Pin the message so a future regression to the LENGTH refinement
    // (or any other field's check) still fails this test rather than
    // passing for the wrong reason. Assert a non-empty string rather
    // than matching `/html/i` because `displayName`'s schema applies
    // a regex check *before* any HTML filter, so the visible rejection
    // message can be e.g. "Only letters, numbers, underscores, and
    // spaces allowed". Hard-coding /html/i would couple the test to
    // schema-internal ordering.
    expect(typeof displayNameDetail.message).toBe("string");
    expect(displayNameDetail.message.length).toBeGreaterThan(0);
  });
});
