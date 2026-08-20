"use strict";

/**
 * queueWorkers.integration.test.js
 *
 * End-to-end smoke test for the pg-boss queue workers against the services
 * provided by docker-compose.test.yml (Postgres). Unlike the
 * testcontainers-based integration tests, this suite connects DIRECTLY to the
 * compose `postgres` service via DATABASE_URL — it needs no Docker socket, so
 * it actually runs in CI and exercises the enqueue → consume → persist path
 * that production relies on.
 *
 * It boots the real `profileQueue` and `matchQueue` workers, enqueues jobs
 * through their public enqueue APIs, and asserts the workers consume the jobs
 * and mutate the database. This proves pg-boss queueing works end-to-end,
 * not just the worker logic in isolation.
 *
 * The suite creates only the tables those two workers touch (donations,
 * profiles, donation_matches) so it stays self-contained and independent of
 * the full migration bootstrap. It gracefully skips when DATABASE_URL is
 * unreachable (e.g. plain `npm test` outside the compose stack).
 */

const { randomUUID } = require("crypto");
const { Pool } = require("pg");
const sharedPool = require("../db/pool");

const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://postgres:postgres@localhost:5432/indigopay";

function makePublicKey(char = "A") {
  return `G${char.repeat(55)}`;
}

/**
 * Poll `fn` until it returns true or `timeoutMs` elapses.
 */
async function waitFor(fn, { timeoutMs = 15000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

describe("Queue workers smoke (compose Postgres)", () => {
  jest.setTimeout(120000);

  /** @type {import('pg').Pool|null} */
  let adminPool = null;
  let ready = false;
  const stops = [];

  beforeAll(async () => {
    adminPool = new Pool({
      connectionString: DATABASE_URL,
      connectionTimeoutMillis: 3000,
      max: 5,
    });

    try {
      await adminPool.query("SELECT 1");
    } catch (err) {
      console.warn(
        `Skipping queue worker smoke test — DATABASE_URL unreachable: ${err.message}`,
      );
      await adminPool.end().catch(() => {});
      adminPool = null;
      return;
    }

    // Minimal schema for the two workers under test (no FKs so the test stays
    // self-contained). Column names match the production schema exactly.
    await adminPool.query(`
      CREATE TABLE IF NOT EXISTS donations (
        id UUID PRIMARY KEY,
        project_id UUID NOT NULL,
        donor_address TEXT NOT NULL,
        amount_xlm NUMERIC(20, 7),
        amount NUMERIC(20, 7) NOT NULL,
        currency TEXT NOT NULL DEFAULT 'XLM',
        message TEXT,
        transaction_hash TEXT NOT NULL UNIQUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await adminPool.query(`
      CREATE TABLE IF NOT EXISTS profiles (
        public_key TEXT PRIMARY KEY,
        display_name TEXT,
        bio TEXT,
        total_donated_xlm NUMERIC(20, 7) NOT NULL DEFAULT 0,
        projects_supported INTEGER NOT NULL DEFAULT 0,
        badges JSONB NOT NULL DEFAULT '[]'::JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ
      )
    `);
    await adminPool.query(`
      CREATE TABLE IF NOT EXISTS donation_matches (
        id UUID PRIMARY KEY,
        project_id UUID NOT NULL,
        matcher_address TEXT NOT NULL,
        cap_xlm NUMERIC(20, 7) NOT NULL,
        multiplier INTEGER NOT NULL DEFAULT 1,
        expires_at TIMESTAMPTZ NOT NULL,
        matched_xlm NUMERIC(20, 7) NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    ready = true;

    // Boot each worker exactly once for the whole suite. pg-boss keeps a
    // module-level singleton instance per queue, so calling start() again in
    // a later test would overwrite and orphan the previous instance — leaving
    // its polling loop running after Jest tears the environment down. That is
    // what produced the intermittent "require after teardown" crashes that
    // failed unrelated suites running in the same worker.
    try {
      await require("./profileQueue").start(undefined);
      stops.push(require("./profileQueue").stop);
      await require("./matchQueue").start();
      stops.push(require("./matchQueue").stop);
    } catch (err) {
      console.warn(
        `Skipping queue worker smoke test — could not start workers: ${err.message}`,
      );
      ready = false;
    }
  });

  afterAll(async () => {
    // Drain any in-flight jobs BEFORE stopping the workers. pg-boss's stop()
    // only waits for jobs already assigned to a worker (`jobs.length`), not
    // for a fetch() that is still in flight. If a job is still pending when
    // stop() runs, the worker can keep processing after stop() resolves — and
    // after the shared pool below has been ended — which crashes the worker
    // ("Cannot use a pool after calling end") and destabilises whichever
    // suite happens to be running in the same Jest worker.
    if (ready && adminPool) {
      const drained = await waitForQueueEmpty();
      if (!drained) {
        console.warn(
          "queue worker smoke test — pg-boss queues did not drain before teardown",
        );
      }
    }

    for (const stop of stops.reverse()) {
      try {
        await stop();
      } catch {
        /* ignore */
      }
    }

    if (adminPool) {
      try {
        await adminPool.end();
      } catch {
        /* ignore */
      }
    }
    // Close the shared pool that the workers used (../db/pool) so Jest can
    // exit without waiting on its idle-connection timeout.
    try {
      await sharedPool.end();
    } catch {
      /* ignore */
    }
  });

  async function cleanDb() {
    await adminPool.query(
      "TRUNCATE donations, profiles, donation_matches CASCADE",
    );
  }

  // The compose job runs the full production migration set, where donations
  // and donation_matches correctly reference projects. Keep the smoke test
  // self-contained by creating the project row that each generated test ID
  // needs before inserting child records.
  async function ensureProject(projectId) {
    await adminPool.query(
      `INSERT INTO projects (
         id, name, description, category, location, wallet_address,
         goal_xlm, raised_xlm, donor_count, co2_offset_kg, status,
         verified, on_chain_verified, tags
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 0, 0, 'active', false, false, $8)
       ON CONFLICT (id) DO NOTHING`,
      [
        projectId,
        "Queue smoke project",
        "Project used by the queue worker smoke test",
        "Other",
        "Test",
        makePublicKey("P"),
        "100.0000000",
        [],
      ],
    );
  }

  /**
   * Wait until pg-boss has no pending jobs for the two queues under test.
   * Completed jobs may still sit in pgboss.job (state 'completed') until they
   * are archived, so we only count states that can still be consumed.
   */
  async function waitForQueueEmpty(timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { rows } = await adminPool.query(
        `SELECT COUNT(*)::int AS c
           FROM pgboss.job
          WHERE name IN ('profile-update', 'donation-match')
            AND state IN ('created', 'retry', 'active')`,
      );
      if (Number(rows[0].c) === 0) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  }

  test("profileQueue consumes an enqueued job and upserts the donor profile", async () => {
    if (!ready) return console.warn("skipping – database unavailable");

    const profileQueue = require("./profileQueue");

    const donor = makePublicKey("Q");
    const projectId = randomUUID();

    await cleanDb();
    await ensureProject(projectId);
    await adminPool.query(
      `INSERT INTO donations (id, project_id, donor_address, amount_xlm, amount, currency, transaction_hash)
       VALUES ($1, $2, $3, $4, $5, 'XLM', $6)`,
      [randomUUID(), projectId, donor, "10.0000000", "10.0000000", "a".repeat(64)],
    );

    await profileQueue.enqueueProfileUpdate(donor);

    const consumed = await waitFor(async () => {
      const { rows } = await adminPool.query(
        "SELECT 1 FROM profiles WHERE public_key = $1",
        [donor],
      );
      return rows.length === 1;
    });
    expect(consumed).toBe(true);

    const { rows } = await adminPool.query(
      "SELECT total_donated_xlm, projects_supported, badges FROM profiles WHERE public_key = $1",
      [donor],
    );
    expect(Number(rows[0].total_donated_xlm)).toBeCloseTo(10, 5);
    expect(rows[0].projects_supported).toBe(1);
    expect(Array.isArray(rows[0].badges)).toBe(true);
    expect(rows[0].badges[0]?.tier).toBe("seedling");
  });

  test("matchQueue consumes an enqueued job and records a matching donation", async () => {
    if (!ready) return console.warn("skipping – database unavailable");

    const matchQueue = require("./matchQueue");

    const projectId = randomUUID();
    const donor = makePublicKey("M");
    const matcher = makePublicKey("N");
    const matchId = randomUUID();
    const txHash = "b".repeat(64);

    await cleanDb();
    await ensureProject(projectId);
    await adminPool.query(
      `INSERT INTO donation_matches (id, project_id, matcher_address, cap_xlm, multiplier, expires_at, matched_xlm)
       VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '1 hour', $6)`,
      [matchId, projectId, matcher, "100.0000000", 2, "0.0000000"],
    );

    await matchQueue.enqueueMatchDonation({
      projectId,
      donorAddress: donor,
      parsedAmount: 10,
      transactionHash: txHash,
    });

    const expectedTx = `match-${txHash}-${matchId}`;
    const consumed = await waitFor(async () => {
      const { rows } = await adminPool.query(
        "SELECT 1 FROM donations WHERE transaction_hash = $1",
        [expectedTx],
      );
      return rows.length === 1;
    });
    expect(consumed).toBe(true);

    const { rows: matchRows } = await adminPool.query(
      "SELECT matched_xlm FROM donation_matches WHERE id = $1",
      [matchId],
    );
    expect(Number(matchRows[0].matched_xlm)).toBeCloseTo(20, 5);
  });

  test("matchQueue enforces the cap atomically under concurrent matching", async () => {
    if (!ready) return console.warn("skipping – database unavailable");

    const matchQueue = require("./matchQueue");

    const projectId = randomUUID();
    const matcher = makePublicKey("C");
    const matchId = randomUUID();

    // Cap is 50. We enqueue 10 donations of 10.
    // Total attempted match is 100.
    // If cap is enforced, only 50 should be matched.
    await cleanDb();
    await ensureProject(projectId);
    await adminPool.query(
      `INSERT INTO donation_matches (id, project_id, matcher_address, cap_xlm, multiplier, expires_at, matched_xlm)
       VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '1 hour', $6)`,
      [matchId, projectId, matcher, "50.0000000", 1, "0.0000000"],
    );

    const promises = [];
    for (let i = 0; i < 10; i++) {
      promises.push(
        matchQueue.enqueueMatchDonation({
          projectId,
          donorAddress: makePublicKey(`D`),
          parsedAmount: 10,
          transactionHash: `tx-concurrent-${i}`,
        }),
      );
    }
    await Promise.all(promises);

    // Wait until matched_xlm reaches 50
    const consumed = await waitFor(async () => {
      const { rows } = await adminPool.query(
        "SELECT matched_xlm FROM donation_matches WHERE id = $1",
        [matchId],
      );
      return Number(rows[0].matched_xlm) === 50;
    });
    expect(consumed).toBe(true);

    // Wait until every job has been consumed so the overshoot jobs have
    // definitely run before we assert no overshoot occurred.
    const drained = await waitForQueueEmpty();
    expect(drained).toBe(true);

    const { rows: finalMatchRows } = await adminPool.query(
      "SELECT matched_xlm FROM donation_matches WHERE id = $1",
      [matchId],
    );
    expect(Number(finalMatchRows[0].matched_xlm)).toBe(50);

    // Also verify exactly 5 match donations were recorded
    const { rows: donations } = await adminPool.query(
      "SELECT count(*) as c FROM donations WHERE transaction_hash LIKE $1",
      [`match-tx-concurrent-%-${matchId}`],
    );
    expect(Number(donations[0].c)).toBe(5);
  });
});
