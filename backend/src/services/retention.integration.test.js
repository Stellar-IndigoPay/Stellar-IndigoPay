"use strict";

/**
 * Integration test for the retention worker against a real PostgreSQL
 * instance (testcontainers). Verifies that delete and anonymize policies
 * actually mutate rows in the database, that the operation is idempotent, and
 * that pending-row counting reflects reality.
 *
 * Run with: INTEGRATION=1 npm test -- retention.integration
 * Skipped gracefully if Docker is unavailable.
 */

jest.mock("../services/audit", () => ({
  logAdminAction: jest.fn().mockResolvedValue(undefined),
}));

const fs = require("fs");
const path = require("path");
const { GenericContainer, Wait } = require("testcontainers");
const { Pool } = require("pg");

const { runPolicy, countPending, runAllPolicies } = require("./retentionWorker");
const config = require("../config/retentionPolicies");

let container;
let testPool;
let ready = false;

describe("Retention worker integration (testcontainers)", () => {
  jest.setTimeout(120000);

  beforeAll(async () => {
    if (process.env.SKIP_INTEGRATION === "1") {
      console.warn("Skipping retention integration (SKIP_INTEGRATION=1)");
      return;
    }
    try {
      container = await new GenericContainer("postgres:15-alpine")
        .withEnvironment({
          POSTGRES_USER: "test",
          POSTGRES_PASSWORD: "test",
          POSTGRES_DB: "indigopay_test",
        })
        .withExposedPorts(5432)
        .withWaitStrategy(
          Wait.forLogMessage("database system is ready to accept connections", 2),
        )
        .withStartupTimeout(60000)
        .start();

      const host = container.getHost();
      const port = container.getMappedPort(5432);
      const connectionString = `postgres://test:test@${host}:${port}/indigopay_test`;
      testPool = new Pool({ connectionString, max: 5 });

      const schemaSql = fs.readFileSync(
        path.join(__dirname, "..", "db", "schema.sql"),
        "utf8",
      );
      await testPool.query(schemaSql);

      // The retention worker depends on the audit service; the real audit
      // table (admin_audit_log) is not part of schema.sql in this repo, so we
      // keep the mocked audit (it's a no-op here). Ensure logAdminAction is a
      // resolved no-op regardless.
      const { logAdminAction } = require("../services/audit");
      logAdminAction.mockResolvedValue(undefined);

      ready = true;
      console.log(`Retention testcontainers PostgreSQL ready at ${host}:${port}`);
    } catch (err) {
      console.warn("Retention integration skipped:", err.message);
      ready = false;
      try {
        if (testPool) await testPool.end();
      } catch {
        /* cleanup */
      }
      try {
        if (container) await container.stop();
      } catch {
        /* cleanup */
      }
      container = null;
      testPool = null;
    }
  });

  afterAll(async () => {
    try {
      if (testPool) await testPool.end();
    } catch {
      /* cleanup */
    }
    try {
      if (container) await container.stop({ timeout: 5000 });
    } catch {
      /* cleanup */
    }
  });

  async function seedDeviceTokens(n, ageMonths) {
    await testPool.query("TRUNCATE device_tokens RESTART IDENTITY CASCADE");
    for (let i = 0; i < n; i++) {
      await testPool.query(
        `INSERT INTO device_tokens (id, token, platform, wallet_address, created_at)
         VALUES ($1, $2, 'ios', $3, now() - ($4 || ' months')::interval)`,
        [`${i}-${Math.random()}`, `tok-${i}`, `G${i}`, ageMonths],
      );
    }
  }

  async function seedSubscriptions(n, ageMonths) {
    await testPool.query(
      "TRUNCATE project_subscriptions RESTART IDENTITY CASCADE",
    );
    // project_subscriptions references projects(id). Seed one project.
    await testPool.query(
      `INSERT INTO projects (id, name, description, category, location, wallet_address, goal_xlm, raised_xlm, donor_count)
       VALUES ('p1','p','d','c','l','G'.repeat(56), 0, 0, 0)
       ON CONFLICT (id) DO NOTHING`,
    );
    for (let i = 0; i < n; i++) {
      await testPool.query(
        `INSERT INTO project_subscriptions (id, project_id, email, donor_address, created_at)
         VALUES ($1, 'p1', $2, $3, now() - ($4 || ' months')::interval)`,
        [`s-${i}`, `u${i}@example.com`, `G${i}`, ageMonths],
      );
    }
  }

  test("delete policy removes only rows older than the retention window", async () => {
    if (!ready) return console.warn("skipping – container unavailable");
    await seedDeviceTokens(5, 13); // all older than 12-month retention
    // add a fresh token that must survive
    await testPool.query(
      `INSERT INTO device_tokens (id, token, platform, wallet_address, created_at)
       VALUES ('fresh','tok-fresh','ios','Gfresh', now())`,
    );

    const policy = config.byName("device-tokens-delete");
    const res = await runPolicy(testPool, policy);
    expect(res.status).toBe("success");
    expect(res.affectedRows).toBe(5);

    const { rows } = await testPool.query("SELECT COUNT(*)::bigint AS c FROM device_tokens");
    expect(Number(rows[0].c)).toBe(1);
  });

  test("anonymize policy nulls PII and is idempotent", async () => {
    if (!ready) return console.warn("skipping – container unavailable");
    await seedSubscriptions(4, 25); // older than 24-month retention

    const policy = config.byName("project-subscriptions-anonymize");
    const res1 = await runPolicy(testPool, policy);
    expect(res1.status).toBe("success");
    expect(res1.affectedRows).toBe(4);

    const { rows: anonymized } = await testPool.query(
      "SELECT COUNT(*)::bigint AS c FROM project_subscriptions WHERE email IS NULL AND anonymised_at IS NOT NULL",
    );
    expect(Number(anonymized[0].c)).toBe(4);

    // Second run should touch nothing.
    const res2 = await runPolicy(testPool, policy);
    expect(res2.affectedRows).toBe(0);

    // The row count is preserved (not deleted).
    const { rows: total } = await testPool.query(
      "SELECT COUNT(*)::bigint AS c FROM project_subscriptions",
    );
    expect(Number(total[0].c)).toBe(4);
  });

  test("countPending reflects real data", async () => {
    if (!ready) return console.warn("skipping – container unavailable");
    await seedDeviceTokens(3, 13);
    const policy = config.byName("device-tokens-delete");
    const pending = await countPending(testPool, policy);
    expect(pending).toBe(3);
  });

  test("multiple policies execute in one runAllPolicies call", async () => {
    if (!ready) return console.warn("skipping – container unavailable");
    await seedDeviceTokens(2, 13);
    await seedSubscriptions(2, 25);

    const results = await runAllPolicies(testPool, { only: [
      "device-tokens-delete",
      "project-subscriptions-anonymize",
    ] });
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === "success")).toBe(true);
  });

  test("unknown table is never targeted (config guard)", async () => {
    if (!ready) return console.warn("skipping – container unavailable");
    const forbidden = {
      name: "x",
      table: "donations",
      strategy: "delete",
      retentionPeriod: { value: 1, unit: "days" },
      condition: "1=1",
    };
    const res = await runPolicy(testPool, forbidden);
    expect(res.status).toBe("failed");
  });
});
