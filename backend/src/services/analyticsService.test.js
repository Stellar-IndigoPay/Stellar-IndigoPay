"use strict";

jest.mock("../db/pool", () => ({
  query: jest.fn(),
  connect: jest.fn(),
}));

const pool = require("../db/pool");
const {
  getDonationTrends,
  getPlatformGrowth,
  getCategoryBreakdown,
  buildCategoryBreakdownQuery,
  buildPlatformGrowthQueries,
  clampRange,
  runBoundedQuery,
  ANALYTICS_STATEMENT_TIMEOUT_MS,
  TRENDS_MAX_DAYS,
  CATEGORY_LIMIT,
  GROWTH_MONTHS_LIMIT,
} = require("./analyticsService");

/**
 * Fake client whose query records every statement. `rowMapper` (optional)
 * returns the rows for a given SQL string; everything else resolves to an
 * empty result so BEGIN/SET LOCAL/COMMIT are no-ops.
 */
function makeClient(rowMapper) {
  const queries = [];
  const client = {
    query: jest.fn(async (sql, values) => {
      const text = String(sql);
      queries.push({ sql: text, values });
      const rows = rowMapper ? rowMapper(text) : undefined;
      return { rows: rows || [] };
    }),
    release: jest.fn(),
  };
  return { client, queries };
}

describe("runBoundedQuery", () => {
  beforeEach(() => jest.clearAllMocks());

  test("runs under SET LOCAL statement_timeout on a dedicated connection and commits", async () => {
    const { client, queries } = makeClient();
    pool.connect.mockResolvedValue(client);

    const result = await runBoundedQuery("SELECT 1", [42]);

    expect(pool.connect).toHaveBeenCalledTimes(1);
    const sqls = queries.map((q) => q.sql);
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls[1]).toBe(`SET LOCAL statement_timeout = ${ANALYTICS_STATEMENT_TIMEOUT_MS}`);
    expect(sqls[2]).toBe("SELECT 1");
    expect(queries[2].values).toEqual([42]);
    expect(sqls[3]).toBe("COMMIT");
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(result.rows).toEqual([]);
  });

  test("rolls back and rethrows when the query fails, releasing the client", async () => {
    const { client, queries } = makeClient();
    client.query.mockRejectedValueOnce(new Error("boom")); // BEGIN fails
    pool.connect.mockResolvedValue(client);

    await expect(runBoundedQuery("SELECT 1")).rejects.toThrow("boom");

    expect(queries.map((q) => q.sql)).toContain("ROLLBACK");
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});

describe("clampRange", () => {
  test("stays unbounded when no range is given", () => {
    expect(clampRange({})).toEqual({ from: null, to: null });
    expect(clampRange()).toEqual({ from: null, to: null });
  });

  test("derives from as to - maxDays when only to is given", () => {
    const to = new Date("2026-08-01T00:00:00Z");
    const { from, to: outTo } = clampRange({ to }, 30);
    expect(outTo.getTime()).toBe(to.getTime());
    expect(from.getTime()).toBe(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  });

  test("derives to as now when only from is given", () => {
    const from = new Date("2026-01-01T00:00:00Z");
    const before = Date.now();
    const { to } = clampRange({ from }, 30);
    expect(to.getTime()).toBeGreaterThanOrEqual(before);
    expect(to.getTime()).toBeLessThanOrEqual(before + 5000);
  });

  test("clamps an over-wide window to maxDays ending at to", () => {
    const from = new Date("2020-01-01T00:00:00Z");
    const to = new Date("2026-08-01T00:00:00Z");
    const { from: outFrom, to: outTo } = clampRange({ from, to }, 30);
    expect(outTo.getTime()).toBe(to.getTime());
    expect(outFrom.getTime()).toBe(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  });

  test("accepts date strings", () => {
    const { from, to } = clampRange({ from: "2026-07-01", to: "2026-08-01" }, 30);
    expect(from.getTime()).toBeGreaterThan(0);
    expect(to.getTime() - from.getTime()).toBeLessThanOrEqual(
      30 * 24 * 60 * 60 * 1000,
    );
  });
});

describe("buildCategoryBreakdownQuery", () => {
  test("unbounded query is capped and filters active projects", () => {
    const { sql, values } = buildCategoryBreakdownQuery();
    expect(sql).toContain(`LIMIT ${CATEGORY_LIMIT}`);
    expect(sql).toContain("WHERE p.status = 'active'");
    expect(values).toEqual([]);
  });

  test("scopes to the created_at range when from/to are given", () => {
    const from = new Date("2026-07-01T00:00:00Z");
    const to = new Date("2026-08-01T00:00:00Z");
    const { sql, values } = buildCategoryBreakdownQuery({ from, to });
    expect(sql).toContain("d.created_at >= $1");
    expect(sql).toContain("d.created_at <= $2");
    expect(sql).toContain("AND p.status = 'active'");
    expect(values[0].getTime()).toBe(from.getTime());
    expect(values[1].getTime()).toBe(to.getTime());
  });
});

describe("buildPlatformGrowthQueries", () => {
  test("monthly growth is capped to a bounded window", () => {
    const { monthly } = buildPlatformGrowthQueries();
    expect(monthly.sql).toContain(`LIMIT ${GROWTH_MONTHS_LIMIT}`);
  });

  test("summary keeps created_at 30-day windows", () => {
    const { summary } = buildPlatformGrowthQueries();
    expect(summary.sql).toContain("created_at >= NOW() - INTERVAL '30 days'");
  });
});

describe("getDonationTrends", () => {
  beforeEach(() => jest.clearAllMocks());

  test("refreshes the view then reads a bounded, date-mapped window", async () => {
    pool.query.mockResolvedValue({ rows: [] });
    const rows = [
      {
        day: new Date("2026-08-01T00:00:00Z"),
        donationCount: 3,
        totalXLM: "120.5",
        uniqueDonors: 2,
        avgDonationXLM: "40.166",
      },
    ];
    const { client, queries } = makeClient((sql) =>
      sql.startsWith("SELECT day,") ? rows : undefined,
    );
    pool.connect.mockResolvedValue(client);

    const data = await getDonationTrends();

    expect(pool.query).toHaveBeenCalledWith(
      "REFRESH MATERIALIZED VIEW CONCURRENTLY mv_daily_donations",
    );
    const select = queries.find((q) => q.sql.startsWith("SELECT day,"));
    expect(select.sql).toContain(`LIMIT ${TRENDS_MAX_DAYS}`);
    expect(data).toEqual([
      {
        day: "2026-08-01",
        donationCount: 3,
        totalXLM: "120.5",
        uniqueDonors: 2,
        avgDonationXLM: "40.166",
      },
    ]);
  });
});

describe("getCategoryBreakdown", () => {
  beforeEach(() => jest.clearAllMocks());

  test("maps rows from the bounded builder query", async () => {
    const rows = [
      { category: "forestry", donationCount: 4, totalXLM: "200.5", donorCount: 2 },
    ];
    const { client, queries } = makeClient((sql) =>
      sql.includes("JOIN projects p") ? rows : undefined,
    );
    pool.connect.mockResolvedValue(client);

    const data = await getCategoryBreakdown({
      from: "2026-07-01",
      to: "2026-08-01",
    });

    const select = queries.find((q) => q.sql.includes("JOIN projects p"));
    expect(select.sql).toContain(`LIMIT ${CATEGORY_LIMIT}`);
    expect(select.values.length).toBe(2);
    expect(data).toEqual([
      { category: "forestry", donationCount: 4, totalXLM: "200.5", donorCount: 2 },
    ]);
  });
});

describe("getPlatformGrowth", () => {
  beforeEach(() => jest.clearAllMocks());

  test("maps summary and monthly growth rows from the bounded queries", async () => {
    const { client } = makeClient((sql) => {
      if (sql.includes("(VALUES (1)) t")) {
        return [
          {
            totalProjects: 5,
            totalDonations: 100,
            totalDonors: 40,
            totalXLM: "5000.5",
            activeDonors30d: 12,
            totalXLM30d: "600.25",
          },
        ];
      }
      if (sql.includes("DATE_TRUNC('month', created_at)")) {
        return [
          {
            month: new Date("2026-08-01T00:00:00Z"),
            donations: 3,
            totalXLM: "120",
            donors: 2,
          },
        ];
      }
      return undefined;
    });
    pool.connect.mockResolvedValue(client);

    const data = await getPlatformGrowth();

    expect(data.summary.totalProjects).toBe(5);
    expect(data.summary.totalXLM).toBe("5000.5");
    expect(data.summary.activeDonors30d).toBe(12);
    expect(data.monthlyGrowth).toEqual([
      { month: "2026-08", donations: 3, totalXLM: "120", donors: 2 },
    ]);
  });
});
