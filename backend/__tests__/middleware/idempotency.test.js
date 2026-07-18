"use strict";

const crypto = require("crypto");
const idempotencyMiddleware = require("../../src/middleware/idempotency");
const pool = require("../../src/db/pool");

jest.mock("../../src/db/pool", () => ({
  query: jest.fn(),
}));

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
    // pool.query for the placeholder insert
    pool.query.mockResolvedValueOnce({ rows: [] });

    await idempotencyMiddleware(req, res, next);

    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(next).toHaveBeenCalledTimes(1);

    // Verify the placeholder was inserted
    const insertCall = pool.query.mock.calls[1];
    expect(insertCall[0]).toContain("INSERT INTO idempotency_keys");
    expect(insertCall[1][0]).toBe(validKey);
    expect(insertCall[1][1]).toBe(hashBody(req.body));
    expect(insertCall[1][2]).toBe(JSON.stringify({ status: "processing" })); // placeholder status
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
    pool.query.mockResolvedValueOnce({ rows: [] }); // Insert placeholder
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
});
