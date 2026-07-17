"use strict";

jest.mock("../../db/pool", () => ({
  query: jest.fn(),
}));

jest.mock("../../logger", () => ({
  error: jest.fn(),
  info: jest.fn(),
}));

const pool = require("../../db/pool");
const inApp = require("./inApp");

describe("inApp channel", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("inserts a notification into in_app_notifications", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const result = await inApp.send({
      recipient: "GAFOL",
      title: "Test",
      body: "Body",
      data: { type: "test" },
    });

    expect(result.status).toBe("sent");
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO in_app_notifications"),
      expect.arrayContaining(["GAFOL", "Test", "Body"]),
    );
  });

  test("returns failure status on db error", async () => {
    pool.query.mockRejectedValueOnce(new Error("db error"));

    const result = await inApp.send({
      recipient: "GAFOL",
      title: "Test",
      body: "Body",
    });

    expect(result.status).toBe("failed");
  });
});
