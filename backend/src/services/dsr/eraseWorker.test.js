"use strict";

const { processEraseJob } = require("./eraseWorker");
const pool = require("../../db/pool");

jest.mock("../../db/pool", () => ({
  connect: jest.fn()
}));

const mockClient = {
  query: jest.fn(),
  release: jest.fn()
};

describe("eraseWorker", () => {
  const donorAddress = "G1234567890";

  beforeEach(() => {
    jest.clearAllMocks();
    pool.connect.mockResolvedValue(mockClient);
    
    mockClient.query.mockImplementation(async (sql, params) => {
      // By default, pretend no active matches
      if (sql.includes("FROM donation_matches") && sql.includes("status = 'active'")) {
        return { rowCount: 0 };
      }
      return { rowCount: 1 };
    });
  });

  test("processEraseJob anonymizes profiles and deletes subscriptions but skips audit logs", async () => {
    const job = { data: { donorAddress } };
    
    const result = await processEraseJob(job);
    
    expect(result.success).toBe(true);

    // Verify client was released
    expect(mockClient.release).toHaveBeenCalled();

    // Verify SQL queries were executed
    const queries = mockClient.query.mock.calls.map(c => c[0]);

    // Profiles should be anonymized
    const profileQueries = queries.filter(q => q.includes("UPDATE profiles SET"));
    expect(profileQueries.length).toBe(1);
    expect(profileQueries[0]).toMatch(/public_key = '[a-f0-9]+'/);

    // Subscriptions should be deleted
    const subQueries = queries.filter(q => q.includes("DELETE FROM project_subscriptions"));
    expect(subQueries.length).toBe(1);

    // Audit logs should be skipped
    const auditQueries = queries.filter(q => q.includes("admin_audit_log"));
    expect(auditQueries.length).toBe(0);
  });

  test("processEraseJob skips profile anonymization if donor has an active match pledge", async () => {
    // Mock active match pledge
    mockClient.query.mockImplementation(async (sql, params) => {
      if (sql.includes("FROM donation_matches") && sql.includes("status = 'active'")) {
        return { rowCount: 1 }; // Has active match
      }
      return { rowCount: 1 };
    });

    const job = { data: { donorAddress } };
    const result = await processEraseJob(job);
    
    expect(result.success).toBe(true);

    const queries = mockClient.query.mock.calls.map(c => c[0]);

    // Profiles should NOT be anonymized
    const profileQueries = queries.filter(q => q.includes("UPDATE profiles SET"));
    expect(profileQueries.length).toBe(0);

    // Subscriptions should still be deleted
    const subQueries = queries.filter(q => q.includes("DELETE FROM project_subscriptions"));
    expect(subQueries.length).toBe(1);
  });
});
