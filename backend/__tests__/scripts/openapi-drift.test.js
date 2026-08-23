"use strict";

/**
 * Tests for scripts/lib/routeSurface.js — the static Express route inventory
 * and OpenAPI drift detector used by scripts/validate-openapi.js.
 *
 * The drift checks are exercised against deliberately drifted fixtures (a
 * spec that documents an endpoint the code does not serve, and vice versa)
 * so that "OpenAPI drift fails CI" is verified in isolation, without needing
 * to boot the server or mutate the real spec.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  normalizePath,
  extractRouterRoutes,
  extractRouterSubMounts,
  parseServerMounts,
  collectSpecRoutes,
  collectImplementationRoutes,
  detectDrift,
} = require("../../../scripts/lib/routeSurface");

const {
  loadSpec,
  checkRouteDrift,
  SPEC_PATH,
  BACKEND_SRC_DIR,
} = require("../../../scripts/validate-openapi");

describe("normalizePath", () => {
  test("converts Express :param to OpenAPI {param}", () => {
    expect(normalizePath("/api/donations/:id/receipt")).toBe(
      "/api/donations/{id}/receipt",
    );
  });

  test("strips a single trailing slash", () => {
    expect(normalizePath("/api/jobs/")).toBe("/api/jobs");
    expect(normalizePath("/")).toBe("/");
  });

  test("collapses duplicate slashes", () => {
    expect(normalizePath("/api//donations///stream")).toBe(
      "/api/donations/stream",
    );
  });
});

describe("extractRouterRoutes", () => {
  test("extracts single-line router.<method> definitions", () => {
    const src = [
      'router.get("/", handler);',
      'router.post("/", limiter, handler);',
      'router.get("/:id", handler);',
      'router.patch("/:id/status", adminRequired, handler);',
    ].join("\n");

    expect(extractRouterRoutes(src)).toEqual([
      { method: "get", path: "/" },
      { method: "post", path: "/" },
      { method: "get", path: "/:id" },
      { method: "patch", path: "/:id/status" },
    ]);
  });

  test("extracts multi-line router.<method> definitions", () => {
    const src = `router.get(
  "/donor/:publicKey",
  readLimiter,
  handler,
);`;

    expect(extractRouterRoutes(src)).toEqual([
      { method: "get", path: "/donor/:publicKey" },
    ]);
  });
});

describe("extractRouterSubMounts", () => {
  test("extracts router.use sub-router mounts", () => {
    const src = [
      'router.use("/queues", require("./admin/queues"));',
      'router.use("/co2", require("./admin/co2"));',
      "router.use(adminRequired);",
    ].join("\n");

    expect(extractRouterSubMounts(src)).toEqual([
      { mount: "/queues", file: "./admin/queues" },
      { mount: "/co2", file: "./admin/co2" },
    ]);
  });
});

describe("parseServerMounts", () => {
  const serverSrc = `
const adminEventsRouter = require("./routes/admin/events");
const analyticsRouter = require("./routes/analytics");
const routeMounts = [
  "donations",
  "projects",
  "admin",
];
app.use("/api/health", require("./routes/health"));
app.use("/health/ready", require("./routes/readiness"));
app.use("/api/admin/events", adminEventsRouter);
app.use("/api/v1/admin/events", adminEventsRouter);
app.use("/api/projects", analyticsRouter);
for (const name of routeMounts) {
  const router = require(\`./routes/\${name}\`);
  app.use(\`/api/\${name}\`, router);
  app.use(\`/api/v1/\${name}\`, router);
}
app.use("/", require("./routes/metrics"));
`;

  test("resolves canonical /api mounts and ignores aliases/internals", () => {
    const mounts = parseServerMounts(serverSrc);
    const flat = mounts.map((m) => `${m.mount} -> ${m.file}`);

    expect(flat).toContain("/api/donations -> ./routes/donations");
    expect(flat).toContain("/api/projects -> ./routes/projects");
    expect(flat).toContain("/api/admin -> ./routes/admin");
    expect(flat).toContain("/api/health -> ./routes/health");
    expect(flat).toContain("/api/admin/events -> ./routes/admin/events");
    expect(flat).toContain("/api/projects -> ./routes/analytics");

    // /api/v1 aliases, /health/ready and / (metrics) are excluded.
    expect(flat).not.toContain("/api/v1/donations -> ./routes/donations");
    expect(flat).not.toContain("/health/ready -> ./routes/readiness");
    expect(flat).not.toContain("/ -> ./routes/metrics");
  });
});

describe("detectDrift", () => {
  test("returns no drift when documented and implemented routes match", () => {
    const spec = new Set(["get /api/donations", "post /api/donations"]);
    const impl = new Set(["get /api/donations", "post /api/donations"]);
    expect(detectDrift(spec, impl)).toEqual({ missing: [], extra: [] });
  });

  test("flags a documented-but-unimplemented endpoint as missing (drift fixture)", () => {
    // Spec drifted ahead of the code: it documents an endpoint that was
    // removed from the implementation.
    const spec = new Set(["get /api/donations", "get /api/donations/stream"]);
    const impl = new Set(["get /api/donations"]);

    const { missing, extra } = detectDrift(spec, impl);
    expect(missing).toEqual(["get /api/donations/stream"]);
    expect(extra).toEqual([]);
  });

  test("flags an implemented-but-undocumented endpoint as extra", () => {
    // Code drifted ahead of the spec: a new endpoint was added without docs.
    const spec = new Set(["get /api/donations"]);
    const impl = new Set(["get /api/donations", "get /api/donations/stream"]);

    const { missing, extra } = detectDrift(spec, impl);
    expect(missing).toEqual([]);
    expect(extra).toEqual(["get /api/donations/stream"]);
  });

  test("sorts results deterministically", () => {
    const spec = new Set(["get /api/b", "get /api/a"]);
    const impl = new Set(["get /api/c"]);
    const { missing, extra } = detectDrift(spec, impl);
    expect(missing).toEqual(["get /api/a", "get /api/b"]);
    expect(extra).toEqual(["get /api/c"]);
  });
});

describe("collectImplementationRoutes (fixture)", () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "route-surface-"));
    fs.mkdirSync(path.join(dir, "routes"), { recursive: true });
    fs.mkdirSync(path.join(dir, "routes", "admin"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(rel, content) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  test("rebuilds the full method+path table from mounts and route modules", () => {
    write(
      "server.js",
      `const routeMounts = ["donations"];
app.use("/api/health", require("./routes/health"));
for (const name of routeMounts) {
  const router = require(\`./routes/\${name}\`);
  app.use(\`/api/\${name}\`, router);
  app.use(\`/api/v1/\${name}\`, router);
}
`,
    );
    write(
      "routes/donations.js",
      'router.get("/", h);\nrouter.post("/", h);\nrouter.get("/:id/receipt", h);',
    );
    write("routes/health.js", 'router.get("/", h);');

    const routes = collectImplementationRoutes(dir);
    expect(routes.has("get /api/donations")).toBe(true);
    expect(routes.has("post /api/donations")).toBe(true);
    expect(routes.has("get /api/donations/{id}/receipt")).toBe(true);
    expect(routes.has("get /api/health")).toBe(true);
    // /api/v1 alias must not leak into the canonical surface.
    expect(routes.has("get /api/v1/donations")).toBe(false);
  });

  test("reaches sub-routers mounted via router.use", () => {
    write(
      "server.js",
      'const routeMounts = ["admin"];\nfor (const name of routeMounts) { app.use(`/api/${name}`, require(`./routes/${name}`)); }',
    );
    write(
      "routes/admin.js",
      'router.use("/queues", require("./admin/queues"));',
    );
    write("routes/admin/queues.js", 'router.get("/", h);\nrouter.get("/:id", h);');

    const routes = collectImplementationRoutes(dir);
    expect(routes.has("get /api/admin/queues")).toBe(true);
    expect(routes.has("get /api/admin/queues/{id}")).toBe(true);
  });
});

describe("collectSpecRoutes", () => {
  test("extracts one entry per documented method", () => {
    const spec = {
      paths: {
        "/api/donations": {
          get: { summary: "List" },
          post: { summary: "Create" },
        },
        "/api/donations/{id}/receipt": {
          get: { summary: "Receipt" },
        },
      },
    };
    expect(collectSpecRoutes(spec)).toEqual(
      new Set([
        "get /api/donations",
        "post /api/donations",
        "get /api/donations/{id}/receipt",
      ]),
    );
  });
});

describe("real repository regression guard", () => {
  test("every endpoint documented in the OpenAPI spec is implemented", () => {
    const spec = loadSpec(SPEC_PATH);
    const { missing } = checkRouteDrift(spec);

    // If this fails, a documented endpoint was removed/renamed in the code
    // without updating the spec — exactly the drift CI is meant to catch.
    expect(missing).toEqual([]);
  });

  test("the real implementation surface is non-empty", () => {
    const implRoutes = collectImplementationRoutes(BACKEND_SRC_DIR);
    expect(implRoutes.size).toBeGreaterThan(0);
    expect(implRoutes.has("post /api/donations")).toBe(true);
    expect(implRoutes.has("get /api/donations/stream")).toBe(true);
  });
});
