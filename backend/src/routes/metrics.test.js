"use strict";

const express = require("express");
const request = require("supertest");
const metricsRouter = require("./metrics");

function buildApp() {
  const app = express();
  app.use("/", metricsRouter);
  return app;
}

describe("GET /metrics (scrape endpoint)", () => {
  const originalBearer = process.env.METRICS_BEARER_TOKEN;
  const originalEnabled = process.env.METRICS_ENABLED;

  afterEach(() => {
    if (originalBearer === undefined) delete process.env.METRICS_BEARER_TOKEN;
    else process.env.METRICS_BEARER_TOKEN = originalBearer;
    if (originalEnabled === undefined) delete process.env.METRICS_ENABLED;
    else process.env.METRICS_ENABLED = originalEnabled;
  });

  test("returns 200 with Prometheus text format when no bearer token is set (dev mode)", async () => {
    delete process.env.METRICS_BEARER_TOKEN;
    const res = await request(buildApp()).get("/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
    // Body should contain at least the default `nodejs_` metrics.
    expect(res.text).toMatch(/^# HELP nodejs_/m);
  });

  test("returns 401 when METRICS_BEARER_TOKEN is set and the header is missing", async () => {
    process.env.METRICS_BEARER_TOKEN = "supersecret";
    const res = await request(buildApp()).get("/");
    expect(res.status).toBe(401);
  });

  test("returns 401 when the bearer token does not match", async () => {
    process.env.METRICS_BEARER_TOKEN = "supersecret";
    const res = await request(buildApp()).get("/").set("Authorization", "Bearer wrong");
    expect(res.status).toBe(401);
  });

  test("returns 200 with the metrics body when the bearer token matches", async () => {
    process.env.METRICS_BEARER_TOKEN = "supersecret";
    const res = await request(buildApp()).get("/").set("Authorization", "Bearer supersecret");
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/^# HELP nodejs_/m);
  });

  test("bearer match is case-insensitive on the scheme prefix", async () => {
    process.env.METRICS_BEARER_TOKEN = "supersecret";
    const res = await request(buildApp()).get("/").set("Authorization", "bearer supersecret");
    expect(res.status).toBe(200);
  });
});
