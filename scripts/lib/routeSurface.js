"use strict";

/**
 * routeSurface.js — static route inventory + OpenAPI drift detection.
 *
 * The OpenAPI spec documents the public `/api/*` surface, while the actual
 * endpoints are registered by Express route modules mounted from
 * `backend/src/server.js`. Keeping these two in lockstep by hand is error
 * prone, so this module statically reconstructs the implemented route table
 * (method + normalized path) from the route files and compares it against the
 * spec's `paths`:
 *
 *   - `missing` — documented in the spec but not implemented (fatal drift:
 *     the docs promise an endpoint the server does not serve).
 *   - `extra`   — implemented but not documented (informational: the spec
 *     intentionally documents only the public surface, not internal/admin/
 *     metrics endpoints).
 *
 * Everything here is a pure function (no process.exit, no globals) so it can
 * be unit-tested against fixtures — including a deliberately drifted one.
 */

const fs = require("fs");
const path = require("path");

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"];

/**
 * Normalize a route path for comparison:
 *   - Express `:param` → OpenAPI `{param}`
 *   - collapse duplicate slashes
 *   - strip a single trailing slash (so `/api/jobs` === `/api/jobs/`)
 */
function normalizePath(p) {
  let out = String(p)
    .replace(/:([A-Za-z0-9_]+)/g, "{$1}")
    .replace(/\/+/g, "/");
  if (out.length > 1 && out.endsWith("/")) {
    out = out.slice(0, -1);
  }
  return out;
}

/**
 * Extract `router.<method>("<path>")` definitions from a route module's
 * source. The `\(\s*` in the pattern also matches a newline between the
 * opening paren and the path string, covering the multi-line style used by
 * some route modules.
 */
function extractRouterRoutes(src) {
  const out = [];
  const re = new RegExp(
    `router\\.(${HTTP_METHODS.join("|")})\\(\\s*["'\`]([^"'\`]+)["'\`]`,
    "g",
  );
  let m;
  while ((m = re.exec(src))) {
    out.push({ method: m[1].toLowerCase(), path: m[2] });
  }
  return out;
}

/**
 * Extract sub-router mounts: `router.use("/sub", require("./admin/xxx"))`.
 */
function extractRouterSubMounts(src) {
  const out = [];
  const re = /router\.use\(\s*["'`]([^"'`]+)["'`]\s*,\s*require\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
  let m;
  while ((m = re.exec(src))) {
    out.push({ mount: m[1], file: m[2] });
  }
  return out;
}

/**
 * Parse `backend/src/server.js` into the canonical `/api` mount table
 * (`{ mount, file }[]`), where `file` is a `./routes/...` module spec.
 *
 * Handles the three mount styles server.js uses:
 *   1. the declarative `routeMounts = [...]` array (mounted as `/api/<name>`),
 *   2. `app.use("/mount", require("./routes/..."))`,
 *   3. `app.use("/mount", <identifier>)` where the identifier is a
 *      `const <identifier> = require("./routes/...")` up top.
 *
 * `/api/v1` aliases, template-literal mounts, and non-`/api` mounts are
 * ignored — the spec only documents the canonical `/api` surface.
 */
function parseServerMounts(serverSrc) {
  const mounts = [];
  const seen = new Set();

  const push = (mount, file) => {
    if (
      !mount.startsWith("/api/") ||
      mount.startsWith("/api/v1") ||
      mount.includes("${")
    ) {
      return;
    }
    const key = `${mount}\u0000${file}`;
    if (seen.has(key)) return;
    seen.add(key);
    mounts.push({ mount, file });
  };

  // 1. Declarative routeMounts array.
  const routeMountsMatch = /const routeMounts\s*=\s*\[([\s\S]*?)\];/.exec(
    serverSrc,
  );
  if (routeMountsMatch) {
    const names = [...routeMountsMatch[1].matchAll(/"([^"]+)"/g)].map(
      (m) => m[1],
    );
    for (const name of names) {
      push(`/api/${name}`, `./routes/${name}`);
    }
  }

  // 2. `const <identifier> = require("./routes/...")` map.
  const varToFile = {};
  {
    const re = /const\s+(\w+)\s*=\s*require\(\s*["'`](\.\/[^"'`]+)["'`]\s*\)/g;
    let m;
    while ((m = re.exec(serverSrc))) {
      varToFile[m[1]] = m[2];
    }
  }

  // 3. `app.use("/mount", require("./routes/..."))`.
  {
    const re = /app\.use\(\s*["'`]([^"'`]+)["'`]\s*,\s*require\(\s*["'`](\.\/[^"'`]+)["'`]\s*\)/g;
    let m;
    while ((m = re.exec(serverSrc))) {
      push(m[1], m[2]);
    }
  }

  // 4. `app.use("/mount", <identifier>)` resolved via varToFile.
  {
    const re = /app\.use\(\s*["'`]([^"'`]+)["'`]\s*,\s*([A-Za-z_$][\w$]*)\s*\)/g;
    let m;
    while ((m = re.exec(serverSrc))) {
      const file = varToFile[m[2]];
      if (file && file.startsWith("./routes/")) {
        push(m[1], file);
      }
    }
  }

  return mounts;
}

/**
 * Recursively walk the route modules reachable from server.js and return the
 * full implemented route table as a `Set` of `"METHOD /normalized/path"`.
 *
 * @param {string} backendSrcDir absolute path to `backend/src`.
 */
function collectImplementationRoutes(backendSrcDir) {
  const serverPath = path.join(backendSrcDir, "server.js");
  const serverSrc = fs.readFileSync(serverPath, "utf8");
  const routes = new Set();

  const add = (method, fullPath) => {
    routes.add(`${method.toLowerCase()} ${normalizePath(fullPath)}`);
  };

  const walk = (fileRel, prefix, depth) => {
    if (depth > 8) return; // guard against accidental cycles
    const abs = path.join(
      backendSrcDir,
      `${fileRel.replace(/^\.\//, "")}.js`,
    );
    if (!fs.existsSync(abs)) return;
    const src = fs.readFileSync(abs, "utf8");

    for (const r of extractRouterRoutes(src)) {
      add(r.method, prefix + r.path);
    }
    for (const sm of extractRouterSubMounts(src)) {
      const dir = path.dirname(abs);
      const target = path.join(dir, sm.file.replace(/^\.\//, ""));
      const rel = path.relative(backendSrcDir, target).replace(/\\/g, "/");
      walk(`./${rel}`, prefix + sm.mount, depth + 1);
    }
  };

  for (const { mount, file } of parseServerMounts(serverSrc)) {
    walk(file, mount, 0);
  }

  // Direct `app.<method>("/api/...")` registrations (e.g. /api/csrf-token).
  {
    const re = new RegExp(
      `app\\.(${HTTP_METHODS.join("|")})\\(\\s*["'\`]([^"'\`]+)["'\`]\\s*[,)]`,
      "g",
    );
    let m;
    while ((m = re.exec(serverSrc))) {
      const method = m[1].toLowerCase();
      const p = m[2];
      if (p.startsWith("/api/") && !p.startsWith("/api/v1")) {
        add(method, p);
      }
    }
  }

  return routes;
}

/**
 * Extract the documented route table from a parsed OpenAPI spec object.
 */
function collectSpecRoutes(spec) {
  const routes = new Set();
  for (const [routePath, pathItem] of Object.entries(spec.paths || {})) {
    for (const method of HTTP_METHODS) {
      if (pathItem[method]) {
        routes.add(`${method} ${normalizePath(routePath)}`);
      }
    }
  }
  return routes;
}

/**
 * Compare the documented routes against the implemented routes.
 *
 * @param {Set<string>|string[]} specRoutes documented `"METHOD /path"` entries
 * @param {Set<string>|string[]} implRoutes implemented `"METHOD /path"` entries
 * @returns {{missing: string[], extra: string[]}} sorted drift lists
 */
function detectDrift(specRoutes, implRoutes) {
  const missing = [...specRoutes].filter((r) => !implRoutes.has(r)).sort();
  const extra = [...implRoutes].filter((r) => !specRoutes.has(r)).sort();
  return { missing, extra };
}

module.exports = {
  HTTP_METHODS,
  normalizePath,
  extractRouterRoutes,
  extractRouterSubMounts,
  parseServerMounts,
  collectImplementationRoutes,
  collectSpecRoutes,
  detectDrift,
};
