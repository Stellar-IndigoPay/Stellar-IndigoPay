"use strict";

jest.mock("../services/audit", () => ({
  logAdminAction: jest.fn().mockResolvedValue(undefined),
}));

const {
  runPolicy,
  runAllPolicies,
  countPending,
  getStatus,
  metrics,
  RETENTION_JOB_NAME,
} = require("./retentionWorker");
const { logAdminAction } = require("../services/audit");
const config = require("../config/retentionPolicies");

// A fake pg client that records queries and returns scripted results.
function makeFakeClient() {
  const queries = [];
  return {
    queries,
    query(sql, params) {
      queries.push({ sql, params });
      // DELETE/UPDATE return a rowCount we control per-call.
      // SELECT COUNT returns pending = 2 by default.
      if (/^SELECT COUNT/i.test(sql)) {
        return Promise.resolve({ rows: [{ pending: "2" }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: this._rowCount ?? 3 });
    },
    _rowCount: 3,
  };
}

describe("retentionWorker", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // reset in-memory last execution map between tests
    metrics.retentionLastRunSeconds.reset();
    metrics.retentionRowsCleanedTotal.reset();
    metrics.retentionRunErrorsTotal.reset();
  });

  test("delete policy executes a parameterized DELETE and reports rows", async () => {
    const client = makeFakeClient();
    const policy = config.byName("device-tokens-delete");
    const res = await runPolicy(client, policy);

    expect(res.status).toBe("success");
    expect(res.affectedRows).toBe(3);
    expect(res.strategy).toBe("delete");
    const del = client.queries.find((q) => /^DELETE FROM/.test(q.sql));
    expect(del).toBeDefined();
    expect(del.params).toEqual([12]);
    expect(del.sql).toContain("device_tokens");
    expect(del.sql).not.toMatch(/donations/);
  });

  test("anonymize policy nulls PII fields and stamps anonymised_at", async () => {
    const client = makeFakeClient();
    const policy = config.byName("project-subscriptions-anonymize");
    const res = await runPolicy(client, policy);

    expect(res.status).toBe("success");
    const upd = client.queries.find((q) => /^UPDATE/.test(q.sql));
    expect(upd).toBeDefined();
    expect(upd.sql).toContain("email = NULL");
    expect(upd.sql).toContain("donor_address = NULL");
    expect(upd.sql).toContain("anonymised_at = NOW()");
    expect(upd.sql).toContain("anonymised_at IS NULL");
  });

  test("anonymize policy is idempotent across repeated runs", async () => {
    const client = makeFakeClient();
    const policy = config.byName("project-subscriptions-anonymize");
    await runPolicy(client, policy);
    const upd1 = client.queries.find((q) => /^UPDATE/.test(q.sql));
    // Simulate already-anonymized rows (no rowCount).
    client._rowCount = 0;
    const res2 = await runPolicy(client, policy);
    expect(res2.affectedRows).toBe(0);
    expect(upd1.sql).toContain("anonymised_at IS NULL");
  });

  test("emits retention_rows_cleaned_total metric with policy+strategy labels", async () => {
    const client = makeFakeClient();
    const policy = config.byName("device-tokens-delete");
    await runPolicy(client, policy);

    const text = await require("./metrics").registry.metrics();
    expect(text).toMatch(
      /retention_rows_cleaned_total\{[^}]*policy="device-tokens-delete"[^}]*strategy="delete"[^}]*\} 3/,
    );
  });

  test("writes an audit entry on success", async () => {
    const client = makeFakeClient();
    const policy = config.byName("device-tokens-delete");
    await runPolicy(client, policy, { actor: "admin-x" });

    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: "admin-x",
        action: "retention.run",
        targetId: "device-tokens-delete",
        metadata: expect.objectContaining({
          strategy: "delete",
          affectedRows: 3,
        }),
      }),
    );
  });

  test("invalid policy name is rejected by runPolicy", async () => {
    const client = makeFakeClient();
    const fake = { name: "evil", table: "donations", strategy: "delete", condition: "1=1", retentionPeriod: { value: 1, unit: "days" } };
    const res = await runPolicy(client, fake);
    expect(res.status).toBe("failed");
    expect(res.error).toMatch(/not in the allow-list|not an object/);
  });

  test("missing table is handled gracefully (no crash, status failed)", async () => {
    const client = makeFakeClient();
    client.query = () => Promise.reject(new Error("relation does not exist"));
    const policy = config.byName("device-tokens-delete");
    const res = await runPolicy(client, policy);
    expect(res.status).toBe("failed");
    expect(res.error).toMatch(/relation does not exist/);
  });

  test("worker continues after a policy failure when running all", async () => {
    const client = makeFakeClient();
    // Make one policy fail by rejecting its specific query.
    const origQuery = client.query.bind(client);
    client.query = (sql, params) => {
      if (sql.includes("pgboss.archive")) {
        return Promise.reject(new Error("no pgboss schema"));
      }
      return origQuery(sql, params);
    };
    const results = await runAllPolicies(client);
    const failed = results.filter((r) => r.status === "failed");
    const succeeded = results.filter((r) => r.status === "success");
    expect(failed.length).toBeGreaterThanOrEqual(1);
    expect(succeeded.length).toBeGreaterThanOrEqual(1);
    expect(results.length).toBe(config.policies.length);
  });

  test("countPending returns the pending row count via parameterized query", async () => {
    const client = makeFakeClient();
    const policy = config.byName("device-tokens-delete");
    const pending = await countPending(client, policy);
    expect(pending).toBe(2);
    const q = client.queries[0];
    expect(q.params).toEqual([12]);
  });

  test("getStatus returns configured policies with pending + last execution", async () => {
    const client = makeFakeClient();
    const policy = config.byName("device-tokens-delete");
    await runPolicy(client, policy);
    const status = await getStatus(client);
    const entry = status.find((s) => s.name === "device-tokens-delete");
    expect(entry).toBeDefined();
    expect(entry.strategy).toBe("delete");
    expect(entry.retentionPeriod).toEqual({ value: 12, unit: "months" });
    expect(entry.pendingRows).toBe(2);
    expect(entry.lastExecution.status).toBe("success");
  });

  test("RETENTION_JOB_NAME is stable", () => {
    expect(RETENTION_JOB_NAME).toBe("data-retention");
  });
});
