"use strict";

const express = require("express");
const request = require("supertest");
const oracleRouter = require("./oracle");
const oracleService = require("../services/oracleService");

jest.mock("../services/oracleService", () => ({
  getCurrentPrice: jest.fn(),
  getLastUpdateTime: jest.fn(),
}));

function buildApp() {
  const app = express();
  app.use("/api/oracle", oracleRouter);
  return app;
}

describe("GET /api/oracle/price", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("returns 200 with cached price, timestamp, and source", async () => {
    const timestamp = Date.now();
    oracleService.getCurrentPrice.mockReturnValue(0.125);
    oracleService.getLastUpdateTime.mockReturnValue(timestamp);

    const res = await request(buildApp()).get("/api/oracle/price");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: {
        price: 0.125,
        updatedAt: timestamp,
        source: "stellar-dex",
      },
    });
  });
});
