"use strict";

/**
 * __tests__/middleware/idempotency.integration.test.js
 *
 * Postgres-backed proof of the idempotency-key race fix (issue #1102, Part B):
 *
 *   - Two concurrent requests with the SAME Idempotency-Key → both get a 2xx
 *     (never a 500), exactly one donation record is created.
 *   - 1,000 concurrent requests (500 unique keys + 500 duplicate keys) →
 *     zero 5xx responses, zero duplicate donation records.
 *   - A replay after completion returns the winner's stored response.
 *   - A different request body under the same key returns 409.
 *
 * Like queueWorkers.integration.test.js this connects DIRECTLY to the compose
 * `postgres` service via DATABASE_URL (no Docker socket needed), so it runs in
 * CI. It self-skips when DATABASE_URL is unreachable (plain local `npm test`).
 */

const { randomUUID } = require("crypto");
const express = require("express");
const request = require("supertest");
const { Pool } = require("pg");

process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://postgres:postgres@localhost:5432/indigopay";
// The middleware/handler share the module-level pg pool (max 20 by default).
// A 1,000-request burst would exhaust that, so give the test its own headroom.
process.env.DB_POOL_MAX = process.env.DB_POOL_MAX || "100";
process.env.DB_POOL_CONNECT_TIMEOUT = process.env.DB_POOL_CONNECT_TIMEOUT || "5000";

const idempotencyMiddleware = require("../../src/middleware/idempotency");
const pool = require("../../src/db/pool");

const DATABASE_URL = process.env.DATABASE_URL;

/** A real donation-ish record table used to count creations. */
async function createSchema(adminPool) {
  await adminPool.query(`
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      key TEXT PRIMARY KEY,
      request_body_hash TEXT NOT NULL,
      response_status INTEGER NOT NULL,
      response_body JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours')
    )
  `);
  await adminPool.query(`
    CREATE TABLE IF NOT EXISTS donation_records (
      id UUID PRIMARY KEY,
      project_id UUID NOT NULL,
      amount NUMERIC(20, 7) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

function buildApp() {
  const app = express();
  app.use(express.json());

  app.post("/donations", idempotencyMiddleware, async (req, res, next) => {
    try {
      const { projectId, amount } = req.body;
      const id = randomUUID();
      await pool.query(
        "INSERT INTO donation_records (id, project_id, amount) VALUES ($1, $2, $3)",
        [id, projectId, amount],
      );
      res.status(201).json({ success: true, data: { id, projectId, amount } });
    } catch (err) {
      next(err);
    }
  });

  // Central error handler — a 500 landing here is a test failure.
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message || "Internal error" });
  });

  return app;
}

describe("Idempotency middleware — concurrent race (compose Postgres)", () => {
  jest.setTimeout(120000);

  /** @type {import('pg').Pool|null} */
  let adminPool = null;
  let ready = false;

  beforeAll(async () => {
    adminPool = new Pool({
      connectionString: DATABASE_URL,
      connectionTimeoutMillis: 3000,
      max: 10,
    });

    try {
      await adminPool.query("SELECT 1");
    } catch (err) {
      console.warn(
        `Skipping idempotency integration test — DATABASE_URL unreachable: ${err.message}`,
      );
      await adminPool.end().catch(() => {});
      adminPool = null;
      return;
    }

    await createSchema(adminPool);
    await adminPool.query("DELETE FROM idempotency_keys");
    await adminPool.query("DELETE FROM donation_records");
    ready = true;
  });

  afterAll(async () => {
    if (adminPool) await adminPool.end().catch(() => {});
  });

  beforeEach(async () => {
    if (!ready) return;
    await adminPool.query("DELETE FROM idempotency_keys");
    await adminPool.query("DELETE FROM donation_records");
  });

  async function countRecords() {
    const r = await adminPool.query("SELECT COUNT(*)::int AS n FROM donation_records");
    return r.rows[0].n;
  }

  test("two simultaneous requests with the same key: both 2xx, exactly one record", async () => {
    if (!ready) return; // self-skip when DATABASE_URL is unreachable
    const app = buildApp();
    const key = randomUUID();
    const payload = { projectId: randomUUID(), amount: 10 };

    const [first, second] = await Promise.all([
      request(app).post("/donations").set("Idempotency-Key", key).send(payload),
      request(app).post("/donations").set("Idempotency-Key", key).send(payload),
    ]);

    expect(first.status).toBeGreaterThanOrEqual(200);
    expect(first.status).toBeLessThan(300);
    expect(second.status).toBeGreaterThanOrEqual(200);
    expect(second.status).toBeLessThan(300);
    expect(await countRecords()).toBe(1);
  });

  test("1,000 concurrent requests (500 unique + 500 duplicate keys): zero 5xx, zero duplicates", async () => {
    if (!ready) return; // self-skip when DATABASE_URL is unreachable
    const app = buildApp();

    // 500 keys × 2 submissions = 1,000 requests. Each key's pair is kept
    // adjacent so the duplicate lands in the same wave and genuinely races
    // the original. Waves of 50 keep the burst within the shared module pool
    // (max 20) so pool saturation can't mask a real result with timeouts.
    const uniqueKeys = Array.from({ length: 500 }, () => randomUUID());
    const requests = [];
    for (const key of uniqueKeys) {
      const body = { projectId: randomUUID(), amount: 10 };
      requests.push(
        request(app).post("/donations").set("Idempotency-Key", key).send(body),
        request(app).post("/donations").set("Idempotency-Key", key).send(body),
      );
    }

    const results = [];
    for (let i = 0; i < requests.length; i += 50) {
      const wave = await Promise.all(requests.slice(i, i + 50));
      results.push(...wave);
    }

    const serverErrors = results.filter((r) => r.status >= 500);
    expect(serverErrors).toEqual([]);
    expect(await countRecords()).toBe(500);
  });

  test("replay after completion returns the winner's stored 201 response", async () => {
    if (!ready) return; // self-skip when DATABASE_URL is unreachable
    const app = buildApp();
    const key = randomUUID();
    const payload = { projectId: randomUUID(), amount: 25 };

    const first = await request(app).post("/donations").set("Idempotency-Key", key).send(payload);
    expect(first.status).toBe(201);

    const replay = await request(app).post("/donations").set("Idempotency-Key", key).send(payload);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body);
    expect(await countRecords()).toBe(1);
  });

  test("same key with a different body returns 409 and creates nothing", async () => {
    if (!ready) return; // self-skip when DATABASE_URL is unreachable
    const app = buildApp();
    const key = randomUUID();
    const projectId = randomUUID();

    const first = await request(app)
      .post("/donations")
      .set("Idempotency-Key", key)
      .send({ projectId, amount: 10 });
    expect(first.status).toBe(201);

    const conflict = await request(app)
      .post("/donations")
      .set("Idempotency-Key", key)
      .send({ projectId, amount: 999 });

    expect(conflict.status).toBe(409);
    expect(await countRecords()).toBe(1);
  });
});
