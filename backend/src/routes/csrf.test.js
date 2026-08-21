"use strict";

const request = require("supertest");
const app = require("../server");

describe("CSRF protection", () => {
  const agent = request.agent(app);

  it("returns a CSRF token from GET /api/v1/csrf-token", async () => {
    const res = await agent.get("/api/v1/csrf-token").expect(200);
    expect(res.body).toEqual(expect.objectContaining({ success: true }));
    expect(typeof res.body.csrfToken).toBe("string");
    expect(res.body.csrfToken.length).toBeGreaterThan(0);
    expect(res.headers["content-security-policy"]).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    );
  });

  it("rejects mutating requests without an X-CSRF-Token header", async () => {
    const res = await agent
      .post("/api/v1/ratings")
      .send({
        projectId: "project-1",
        donorAddress:
          "GA123456789012345678901234567890123456789012345678901234",
        rating: 5,
      })
      .expect(403);

    expect(res.body.error.code).toBe("FORBIDDEN");
    expect(res.body.error.message.toLowerCase()).toContain("csrf");
  });

  it("allows mutating requests when a valid X-CSRF-Token header is provided", async () => {
    const tokenResponse = await agent.get("/api/v1/csrf-token").expect(200);
    const token = tokenResponse.body.csrfToken;

    // Use an out-of-range rating so the ratings route rejects the payload
    // with a 400 (validation) instead of a 403 (CSRF). A 400 proves the
    // valid token let the request through, without depending on a migrated
    // `project_ratings` table in the test database.
    const res = await agent
      .post("/api/v1/ratings")
      .set("X-CSRF-Token", token)
      .send({
        projectId: "project-1",
        donorAddress:
          "GA123456789012345678901234567890123456789012345678901234",
        rating: 9,
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});
