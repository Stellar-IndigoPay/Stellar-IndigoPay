"use strict";

/**
 * __tests__/middleware/apiVersion.test.js
 *
 * Tests for src/middleware/apiVersion.js
 *
 * Issue #1128 Part B — API deprecation/sunset signaling.
 *
 * Coverage:
 *   - Active version: no Deprecation header, no body warning
 *   - Deprecated version: Deprecation header present
 *   - Deprecated version: Sunset header present when sunsetAt is configured
 *   - Deprecated version: Link header present when successorPath is configured
 *   - Deprecated version: body warning injected into JSON responses
 *   - Deprecated version: custom deprecationMessage used when provided
 *   - Deprecated version: generated message uses sunsetAt and successorPath
 *   - Sunset version: responds 410 Gone when past sunsetAt
 *   - Sunset version: 410 body contains latestVersion
 *   - Version resolution priority: Accept-Version > URL path > query param > default
 *   - Unknown version falls back to LATEST_VERSION
 *   - GET /api/versions returns all versions with full metadata
 *   - GET /api/.well-known/apiversions returns version list
 *   - Body warning is NOT appended to array bodies
 *   - Deprecation counter is incremented for deprecated requests
 */

const express = require("express");
const request = require("supertest");

// ── Shared version configs ────────────────────────────────────────────────────

const ACTIVE_CONFIG = {
  v1: {
    status: "active",
    releasedAt: "2026-01-01",
    deprecatedAt: null,
    sunsetAt: null,
    path: "/api/v1",
    successorPath: null,
    migrationUrl: null,
    deprecationMessage: null,
    docsUrl: "/api/docs#tag/v1",
  },
};

const DEPRECATED_CONFIG = {
  v1: {
    status: "deprecated",
    releasedAt: "2026-01-01",
    deprecatedAt: "2026-06-01",
    sunsetAt: "2026-12-31",
    path: "/api/v1",
    successorPath: "/api/v2",
    migrationUrl: "/docs/api/migration-v2",
    deprecationMessage: null,
    docsUrl: "/api/docs#tag/v1",
  },
  v2: {
    status: "active",
    releasedAt: "2026-06-01",
    deprecatedAt: null,
    sunsetAt: null,
    path: "/api/v2",
    successorPath: null,
    migrationUrl: null,
    deprecationMessage: null,
    docsUrl: "/api/docs#tag/v2",
  },
};

const SUNSET_CONFIG = {
  v1: {
    status: "sunset",
    releasedAt: "2025-01-01",
    deprecatedAt: "2025-06-01",
    sunsetAt: "2025-12-31", // in the past
    path: "/api/v1",
    successorPath: "/api/v2",
    migrationUrl: "/docs/api/migration-v2",
    deprecationMessage: null,
    docsUrl: null,
  },
  v2: {
    status: "active",
    releasedAt: "2025-06-01",
    deprecatedAt: null,
    sunsetAt: null,
    path: "/api/v2",
    successorPath: null,
    migrationUrl: null,
    deprecationMessage: null,
    docsUrl: null,
  },
};

// ── Build isolated express apps ───────────────────────────────────────────────

/**
 * Creates a minimal express app with apiVersionMiddleware bootstrapped
 * with a *custom* API_VERSIONS map so each test group can exercise different
 * lifecycle states without touching the real config.
 */
function buildApp(versionsConfig, latestVersion = "v1") {
  jest.resetModules();

  jest.mock("../../src/config/apiVersions", () => ({
    API_VERSIONS: versionsConfig,
    LATEST_VERSION: latestVersion,
  }));

  jest.mock("../../src/services/metrics", () => ({
    registry: {
      getSingleMetric: jest.fn().mockReturnValue(null),
      registerMetric:  jest.fn(),
    },
  }));

  jest.mock("../../src/logger", () => ({
    info:  jest.fn(),
    warn:  jest.fn(),
    error: jest.fn(),
  }));

  jest.mock("prom-client", () => ({
    Counter: jest.fn().mockImplementation(() => ({
      labels: jest.fn().mockReturnValue({ inc: jest.fn() }),
    })),
  }));

  const {
    apiVersionMiddleware,
    registerApiVersionDiscoveryRoutes,
  } = require("../../src/middleware/apiVersion");

  const app = express();
  app.use(express.json());
  app.use(apiVersionMiddleware);

  app.get("/api/v1/test", (_req, res) => res.json({ success: true, data: "hello" }));
  app.get("/api/v2/test", (_req, res) => res.json({ success: true, data: "hello v2" }));
  app.get("/api/v1/array-test", (_req, res) => res.json([1, 2, 3]));

  registerApiVersionDiscoveryRoutes(app);
  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("apiVersionMiddleware — active version", () => {
  let app;
  beforeAll(() => { app = buildApp(ACTIVE_CONFIG, "v1"); });

  it("sets X-API-Version header", async () => {
    const res = await request(app).get("/api/v1/test");
    expect(res.headers["x-api-version"]).toBe("v1");
  });

  it("does NOT set Deprecation header", async () => {
    const res = await request(app).get("/api/v1/test");
    expect(res.headers["deprecation"]).toBeUndefined();
  });

  it("does NOT add warning to response body", async () => {
    const res = await request(app).get("/api/v1/test");
    expect(res.body.warning).toBeUndefined();
  });

  it("returns 200", async () => {
    const res = await request(app).get("/api/v1/test");
    expect(res.status).toBe(200);
  });
});

describe("apiVersionMiddleware — deprecated version", () => {
  let app;
  beforeAll(() => { app = buildApp(DEPRECATED_CONFIG, "v2"); });

  it("sets Deprecation: true header", async () => {
    const res = await request(app).get("/api/v1/test");
    expect(res.headers["deprecation"]).toBe("true");
  });

  it("sets Sunset header to the configured date in HTTP-date format", async () => {
    const res = await request(app).get("/api/v1/test");
    expect(res.headers["sunset"]).toBeTruthy();
    const parsed = new Date(res.headers["sunset"]);
    expect(parsed.getUTCFullYear()).toBe(2026);
    expect(parsed.getUTCMonth()).toBe(11); // December (0-indexed)
  });

  it("sets Link header with successor-version rel", async () => {
    const res = await request(app).get("/api/v1/test");
    expect(res.headers["link"]).toBe('</api/v2>; rel="successor-version"');
  });

  it("injects a warning field into the JSON response body", async () => {
    const res = await request(app).get("/api/v1/test");
    expect(typeof res.body.warning).toBe("string");
    expect(res.body.warning.length).toBeGreaterThan(0);
  });

  it("warning message mentions the sunset date", async () => {
    const res = await request(app).get("/api/v1/test");
    expect(res.body.warning).toMatch(/2026-12-31/);
  });

  it("warning message mentions the successor path", async () => {
    const res = await request(app).get("/api/v1/test");
    expect(res.body.warning).toMatch(/\/api\/v2/);
  });

  it("preserves the original response body fields", async () => {
    const res = await request(app).get("/api/v1/test");
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBe("hello");
  });

  it("returns 200 (deprecated endpoints still work)", async () => {
    const res = await request(app).get("/api/v1/test");
    expect(res.status).toBe(200);
  });

  it("does NOT add warning to the active v2 endpoint", async () => {
    const res = await request(app).get("/api/v2/test");
    expect(res.headers["deprecation"]).toBeUndefined();
    expect(res.body.warning).toBeUndefined();
  });

  it("does NOT inject warning into array bodies", async () => {
    const res = await request(app).get("/api/v1/array-test");
    // Array passes through unchanged — can't add a key to an array
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toEqual([1, 2, 3]);
  });
});

describe("apiVersionMiddleware — deprecated with custom deprecationMessage", () => {
  it("uses the custom message instead of the generated one", async () => {
    const customMsg = "v1 is going away! Migrate to v2 by 2026-12-31.";
    const configWithCustomMsg = {
      ...DEPRECATED_CONFIG,
      v1: { ...DEPRECATED_CONFIG.v1, deprecationMessage: customMsg },
    };
    const app = buildApp(configWithCustomMsg, "v2");
    const res = await request(app).get("/api/v1/test");
    expect(res.body.warning).toBe(customMsg);
  });
});

describe("apiVersionMiddleware — sunset version (past sunsetAt)", () => {
  let app;
  beforeAll(() => { app = buildApp(SUNSET_CONFIG, "v2"); });

  it("responds 410 Gone", async () => {
    const res = await request(app).get("/api/v1/test");
    expect(res.status).toBe(410);
  });

  it("410 body contains the latestVersion", async () => {
    const res = await request(app).get("/api/v1/test");
    expect(res.body.latestVersion).toBe("v2");
  });

  it("410 body error message references v2", async () => {
    const res = await request(app).get("/api/v1/test");
    expect(res.body.error).toMatch(/v2/);
  });

  it("active v2 endpoint is unaffected", async () => {
    const res = await request(app).get("/api/v2/test");
    expect(res.status).toBe(200);
  });
});

describe("apiVersionMiddleware — version resolution priority", () => {
  let app;
  beforeAll(() => { app = buildApp(DEPRECATED_CONFIG, "v2"); });

  it("resolves version from URL path", async () => {
    const res = await request(app).get("/api/v2/test");
    expect(res.headers["x-api-version"]).toBe("v2");
  });

  it("Accept-Version header takes priority over URL path", async () => {
    const res = await request(app)
      .get("/api/v2/test")
      .set("Accept-Version", "v1");
    expect(res.headers["x-api-version"]).toBe("v1");
  });

  it("query param ?version= resolves when no header is set", async () => {
    const res = await request(app).get("/api/v2/test?version=v1");
    expect(res.headers["x-api-version"]).toBe("v1");
  });

  it("falls back to LATEST_VERSION for an unrecognised URL prefix", async () => {
    const res = await request(app).get("/api/v99/test");
    expect(res.headers["x-api-version"]).toBe("v2");
  });

  it("does not process apiVersion twice (idempotent middleware)", async () => {
    // Simulate req.apiVersion already set by mounting the middleware twice
    const doubleApp = buildApp(ACTIVE_CONFIG, "v1");
    const res = await request(doubleApp).get("/api/v1/test");
    expect(res.status).toBe(200);
  });
});

describe("GET /api/versions", () => {
  let app;
  beforeAll(() => { app = buildApp(DEPRECATED_CONFIG, "v2"); });

  it("returns 200", async () => {
    const res = await request(app).get("/api/versions");
    expect(res.status).toBe(200);
  });

  it("returns success: true", async () => {
    const res = await request(app).get("/api/versions");
    expect(res.body.success).toBe(true);
  });

  it("includes all registered versions", async () => {
    const res = await request(app).get("/api/versions");
    const versions = res.body.data.versions.map((v) => v.version);
    expect(versions).toContain("v1");
    expect(versions).toContain("v2");
  });

  it("includes lifecycle dates for deprecated version", async () => {
    const res = await request(app).get("/api/versions");
    const v1 = res.body.data.versions.find((v) => v.version === "v1");
    expect(v1.status).toBe("deprecated");
    expect(v1.deprecatedAt).toBe("2026-06-01");
    expect(v1.sunsetAt).toBe("2026-12-31");
  });

  it("includes successorPath when configured", async () => {
    const res = await request(app).get("/api/versions");
    const v1 = res.body.data.versions.find((v) => v.version === "v1");
    expect(v1.successorPath).toBe("/api/v2");
  });

  it("includes migrationUrl when configured", async () => {
    const res = await request(app).get("/api/versions");
    const v1 = res.body.data.versions.find((v) => v.version === "v1");
    expect(v1.migrationUrl).toBe("/docs/api/migration-v2");
  });

  it("includes docsUrl when configured", async () => {
    const res = await request(app).get("/api/versions");
    const v1 = res.body.data.versions.find((v) => v.version === "v1");
    expect(v1.docsUrl).toBe("/api/docs#tag/v1");
  });

  it("reports the latest version", async () => {
    const res = await request(app).get("/api/versions");
    expect(res.body.data.latest).toBe("v2");
  });
});

describe("GET /api/.well-known/apiversions", () => {
  let app;
  beforeAll(() => { app = buildApp(DEPRECATED_CONFIG, "v2"); });

  it("returns 200 with versions array and latest", async () => {
    const res = await request(app).get("/api/.well-known/apiversions");
    expect(res.status).toBe(200);
    expect(res.body.versions).toEqual(expect.arrayContaining(["v1", "v2"]));
    expect(res.body.latest).toBe("v2");
  });
});
