"use strict";

const crypto = require("crypto");
const idempotencyMiddleware = require("../../src/middleware/idempotency");
const pool = require("../../src/db/pool");

jest.mock("../../src/db/pool", () => ({
  query: jest.fn(),
}));

jest.mock("../../src/services/metrics", () => ({
  metrics: {
    idempotencyRaceWinsTotal: { inc: jest.fn() },
  },
}));

const { metrics } = require("../../src/services/metrics");

function hashBody(body) {
  return crypto.createHash("sha256").update(JSON.stringify(body || {})).digest("hex");
}

describe("Idempotency Middleware", () => {
  let req;
  let res;
  let next;

  beforeEach(() => {
    jest.clearAllMocks();

    req = {
      headers: {},
      body: { amount: 10, projectId: "project-1" },
    };

    res = {
      statusCode: 200,
      body: null,
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockImplementation(function (data) {
        this.body = data;
        return this;
      }),
    };

    next = jest.fn();
  });

  const validKey = "550e8400-e29b-41d4-a716-446655440000";

  test("returns 400 when Idempotency-Key is not a valid UUID", async () => {
    req.headers["idempotency-key"] = "not-a-uuid";

    await idempotencyMiddleware(req, res, next);

    expect(pool.query).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "Idempotency-Key must be a valid UUID" });
  });

  test("works as normal when no Idempotency-Key header is provided", async () => {
    await idempotencyMiddleware(req, res, next);

    expect(pool.query).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith(); // no args
  });

  test("treats expired key as a new request", async () => {
    req.headers["idempotency-key"] = validKey;

    // pool.query returns no rows (simulating no unexpired key found)
    pool.query.mockResolvedValueOnce({ rows: [] });
    // pool.query for the placeholder insert — this request wins the race
    pool.query.mockResolvedValueOnce({ rows: [{ key: validKey }] });

    await idempotencyMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);

    // Verify the race-safe placeholder insert
    const insertCall = pool.query.mock.calls[1];
    expect(insertCall[0]).toContain("INSERT INTO idempotency_keys");
    expect(insertCall[0]).toContain("ON CONFLICT (key) DO NOTHING");
    expect(insertCall[0]).toContain("RETURNING key");
    expect(insertCall[1][0]).toBe(validKey);
    expect(insertCall[1][1]).toBe(hashBody(req.body));
    expect(insertCall[1][2]).toBe(JSON.stringify({ status: "processing" })); // placeholder status

    // The winner increments the race counter with outcome=won
    expect(metrics.idempotencyRaceWinsTotal.inc).toHaveBeenCalledWith({ outcome: "won" });
  });

  test("first POST with key allows processing, second POST with same key replays response", async () => {
    req.headers["idempotency-key"] = validKey;

    const cachedResponse = { success: true, data: { id: "donation-1" } };
    const bodyHash = hashBody(req.body);

    // Mock pool to simulate the key already existing and being valid
    pool.query.mockResolvedValueOnce({
      rows: [
        {
          key: validKey,
          request_body_hash: bodyHash,
          response_status: 201,
          response_body: cachedResponse,
        },
      ],
    });

    await idempotencyMiddleware(req, res, next);

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(cachedResponse);
  });

  test("POST with same key but different body returns 409 Conflict", async () => {
    req.headers["idempotency-key"] = validKey;

    // Make the request body different than what was stored
    const storedHash = hashBody({ amount: 100, projectId: "project-1" });

    // Mock pool to simulate the key existing but with a different body hash
    pool.query.mockResolvedValueOnce({
      rows: [
        {
          key: validKey,
          request_body_hash: storedHash,
          response_status: 201,
          response_body: { success: true },
        },
      ],
    });

    await idempotencyMiddleware(req, res, next);

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      error: "Idempotency key reused with different request body",
    });
  });

  test("captures and persists the response when processing completes", async () => {
    req.headers["idempotency-key"] = validKey;

    pool.query.mockResolvedValueOnce({ rows: [] }); // Lookup: not found
    pool.query.mockResolvedValueOnce({ rows: [{ key: validKey }] }); // Insert placeholder (race win)
    pool.query.mockResolvedValueOnce({ rows: [] }); // Update response

    await idempotencyMiddleware(req, res, next);

    // Assert that res.json was wrapped
    res.statusCode = 201;
    const finalResponseBody = { success: true, id: "donation-new" };

    // Simulate the route handler calling res.json
    res.json(finalResponseBody);

    expect(pool.query).toHaveBeenCalledTimes(3);

    // Check the UPDATE query
    const updateCall = pool.query.mock.calls[2];
    expect(updateCall[0]).toContain("UPDATE idempotency_keys SET response_body = $1");
    expect(updateCall[1][0]).toBe(JSON.stringify(finalResponseBody));
    expect(updateCall[1][1]).toBe(201);
    expect(updateCall[1][2]).toBe(validKey);
  });

  // ── Race-condition coverage (issue #1102, Part B) ─────────────────────────

  test("race loser: empty RETURNING re-reads the winner's row and replays it without processing", async () => {
    req.headers["idempotency-key"] = validKey;

    const winnerResponse = { success: true, data: { id: "donation-race-winner" } };
    const bodyHash = hashBody(req.body);

    pool.query.mockResolvedValueOnce({ rows: [] }); // Lookup: not found
    pool.query.mockResolvedValueOnce({ rows: [] }); // INSERT lost the race (no RETURNING row)
    pool.query.mockResolvedValueOnce({
      // Re-read: the winner's row (same body hash)
      rows: [
        {
          key: validKey,
          request_body_hash: bodyHash,
          response_status: 201,
          response_body: winnerResponse,
        },
      ],
    });

    await idempotencyMiddleware(req, res, next);

    // The loser must NOT proceed with processing
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(winnerResponse);
    expect(metrics.idempotencyRaceWinsTotal.inc).toHaveBeenCalledWith({ outcome: "lost" });
  });

  test("race loser with different body hash returns 409 from the winner's row", async () => {
    req.headers["idempotency-key"] = validKey;

    const storedHash = hashBody({ amount: 100, projectId: "project-1" });

    pool.query.mockResolvedValueOnce({ rows: [] }); // Lookup: not found
    pool.query.mockResolvedValueOnce({ rows: [] }); // INSERT lost the race
    pool.query.mockResolvedValueOnce({
      rows: [
        {
          key: validKey,
          request_body_hash: storedHash,
          response_status: 201,
          response_body: { success: true },
        },
      ],
    });

    await idempotencyMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      error: "Idempotency key reused with different request body",
    });
  });

  test("race loser whose winner row expired mid-race falls through and processes", async () => {
    req.headers["idempotency-key"] = validKey;

    pool.query.mockResolvedValueOnce({ rows: [] }); // Lookup: not found
    pool.query.mockResolvedValueOnce({ rows: [] }); // INSERT lost the race
    pool.query.mockResolvedValueOnce({ rows: [] }); // Re-read: winner row already expired

    await idempotencyMiddleware(req, res, next);

    // Falls through: wrapped res.json + next() so the request is processed
    expect(next).toHaveBeenCalledTimes(1);
    expect(metrics.idempotencyRaceWinsTotal.inc).toHaveBeenCalledWith({ outcome: "lost" });
  });
});
