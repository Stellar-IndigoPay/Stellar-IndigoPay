"use strict";

jest.mock("../db/pool", () => ({
  query: jest.fn(),
  connect: jest.fn(),
}));

const pool = require("../db/pool");
const { replayDelivery } = require("./webhookQueue");

describe("replayDelivery", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("returns false when no dead-lettered delivery matches the id", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] }); // UPDATE ... WHERE status = 'dlq' RETURNING id

    const result = await replayDelivery("missing-id");

    expect(result).toBe(false);
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  test("resets attempts and status before retrying", async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: "delivery-1" }] }) // reset UPDATE
      .mockResolvedValueOnce({ rows: [] }); // processDelivery's lookup SELECT (row vanished path)

    const result = await replayDelivery("delivery-1");

    expect(result).toBe(true);
    const [resetQuery, resetParams] = pool.query.mock.calls[0];
    expect(resetQuery).toContain("status = 'pending'");
    expect(resetQuery).toContain("attempts = 0");
    expect(resetQuery).toContain("WHERE id = $1 AND status = 'dlq'");
    expect(resetParams).toEqual(["delivery-1"]);
  });

  test("does not reset a delivery that isn't currently dead-lettered", async () => {
    // The UPDATE's WHERE clause filters on status = 'dlq', so a pending/
    // delivered row simply won't match and RETURNING yields no rows.
    pool.query.mockResolvedValueOnce({ rows: [] });

    const result = await replayDelivery("already-pending");

    expect(result).toBe(false);
  });
});
