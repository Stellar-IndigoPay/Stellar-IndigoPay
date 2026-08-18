"use strict";

const express = require("express");
const request = require("supertest");

const mockDeprecationInc = jest.fn();

jest.mock("prom-client", () => ({
  Counter: jest.fn().mockImplementation(() => ({
    labels: jest.fn().mockReturnValue({ inc: mockDeprecationInc }),
  })),
}));

jest.mock("../logger", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock("../services/metrics", () => ({
  registry: {
    getSingleMetric: jest.fn().mockReturnValue(null),
  },
}));

const { API_VERSIONS, LATEST_VERSION } = require("../config/apiVersions");
const logger = require("../logger");
const {
  apiVersionMiddleware,
  registerApiVersionDiscoveryRoutes,
} = require("./apiVersion");

const originalV1Config = { ...API_VERSIONS.v1 };

function buildApp() {
  const app = express();

  app.use("/api", apiVersionMiddleware);
  app.use("/api/v1", apiVersionMiddleware);
  registerApiVersionDiscoveryRoutes(app);

  app.get("/api/test", (req, res) => {
    res.json({ version: req.apiVersion });
  });

  app.get("/api/v1/test", (req, res) => {
    res.json({ version: req.apiVersion });
  });

  app.get("/api/:version/test", (req, res) => {
    res.json({ version: req.apiVersion });
  });

  return app;
}

describe("apiVersionMiddleware", () => {
  beforeEach(() => {
    API_VERSIONS.v1 = { ...originalV1Config };
    delete API_VERSIONS.v2;
    jest.clearAllMocks();
  });

  test("Accept-Version header takes priority over path", async () => {
    API_VERSIONS.v2 = {
      status: "preview",
      releasedAt: "2027-01-01",
      deprecatedAt: null,
      sunsetAt: null,
      path: "/api/v2",
    };

    const res = await request(buildApp())
      .get("/api/v1/test")
      .set("Accept-Version", "v2")
      .expect(200);

    expect(res.body.version).toBe("v2");
    expect(res.headers["x-api-version"]).toBe("v2");
  });

  test("query param version is used when no header/path version applies", async () => {
    API_VERSIONS.v2 = {
      status: "preview",
      releasedAt: "2027-01-01",
      deprecatedAt: null,
      sunsetAt: null,
      path: "/api/v2",
    };

    const res = await request(buildApp()).get("/api/test?version=v2").expect(200);
    expect(res.body.version).toBe("v2");
    expect(res.headers["x-api-version"]).toBe("v2");
  });

  test("path version is used when available", async () => {
    API_VERSIONS.v2 = {
      status: "preview",
      releasedAt: "2027-01-01",
      deprecatedAt: null,
      sunsetAt: null,
      path: "/api/v2",
    };

    const res = await request(buildApp()).get("/api/v2/test").expect(200);
    expect(res.body.version).toBe("v2");
    expect(res.headers["x-api-version"]).toBe("v2");
  });

  test("missing or unknown version falls back to latest", async () => {
    const resUnknown = await request(buildApp())
      .get("/api/test")
      .set("Accept-Version", "v99")
      .expect(200);
    expect(resUnknown.body.version).toBe(LATEST_VERSION);
    expect(resUnknown.headers["x-api-version"]).toBe(LATEST_VERSION);

    const resMissing = await request(buildApp()).get("/api/test").expect(200);
    expect(resMissing.body.version).toBe(LATEST_VERSION);
    expect(resMissing.headers["x-api-version"]).toBe(LATEST_VERSION);
  });

  test("deprecated version sets Deprecation and Sunset headers", async () => {
    API_VERSIONS.v1.status = "deprecated";
    API_VERSIONS.v1.deprecatedAt = "2026-10-01";
    API_VERSIONS.v1.sunsetAt = "2026-12-01T00:00:00.000Z";

    const res = await request(buildApp()).get("/api/test").expect(200);

    expect(res.headers["deprecation"]).toBe("true");
    expect(res.headers.sunset).toBe(
      new Date(API_VERSIONS.v1.sunsetAt).toUTCString(),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "deprecated_api_usage",
        version: "v1",
        path: "/test",
      }),
      "Deprecated API version used",
    );
  });

  test("sunset version returns 410 with migration guidance", async () => {
    API_VERSIONS.v1.status = "sunset";
    API_VERSIONS.v1.sunsetAt = "2000-01-01T00:00:00.000Z";

    const res = await request(buildApp()).get("/api/test").expect(410);

    expect(res.body).toEqual({
      error: `API v1 has been sunset. Please upgrade to ${LATEST_VERSION}.`,
      latestVersion: LATEST_VERSION,
      migrationUrl: "/docs/api/migration",
      sunset: "2000-01-01T00:00:00.000Z",
    });
  });

  test("GET /api/versions lists available versions and metadata", async () => {
    API_VERSIONS.v2 = {
      status: "preview",
      releasedAt: "2027-01-01",
      deprecatedAt: null,
      sunsetAt: null,
      path: "/api/v2",
    };

    const res = await request(buildApp()).get("/api/versions").expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.latest).toBe(LATEST_VERSION);
    expect(res.body.data.versions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ version: "v1", status: API_VERSIONS.v1.status }),
        expect.objectContaining({ version: "v2", status: "preview" }),
      ]),
    );
  });

  test("GET /api/.well-known/apiversions returns version list", async () => {
    const res = await request(buildApp())
      .get("/api/.well-known/apiversions")
      .expect(200);

    expect(res.body).toEqual({
      versions: Object.keys(API_VERSIONS),
      latest: LATEST_VERSION,
    });
  });
});
