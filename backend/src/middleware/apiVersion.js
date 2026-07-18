"use strict";

const { Counter } = require("prom-client");

const logger = require("../logger");
const { API_VERSIONS, LATEST_VERSION } = require("../config/apiVersions");
const { registry } = require("../services/metrics");

const DEPRECATION_COUNTER_NAME = "indigopay_deprecated_api_requests_total";

const deprecationCounter =
  registry.getSingleMetric(DEPRECATION_COUNTER_NAME) ||
  new Counter({
    name: DEPRECATION_COUNTER_NAME,
    help: "Total requests to deprecated API versions",
    labelNames: ["version", "path"],
    registers: [registry],
  });

function normaliseVersion(candidate) {
  if (!candidate || typeof candidate !== "string") return null;
  const raw = candidate.trim().toLowerCase();
  if (!raw) return null;
  if (/^v\d+$/.test(raw)) return raw;
  if (/^\d+$/.test(raw)) return `v${raw}`;
  return null;
}

function resolveVersion(req) {
  // Priority 1: Accept-Version header (supports comma-separated values).
  const acceptVersion = req.get("Accept-Version");
  if (acceptVersion) {
    const headerCandidates = acceptVersion
      .split(",")
      .map((entry) => normaliseVersion(entry));
    for (const candidate of headerCandidates) {
      if (candidate && API_VERSIONS[candidate]) return candidate;
    }
  }

  // Priority 2: URL path (/api/v1/*, /api/v2/*, ...)
  const requestPath = `${req.baseUrl || ""}${req.path || ""}`;
  const pathMatch = requestPath.match(/^\/api\/(v\d+)(\/|$)/i);
  if (pathMatch) {
    const pathVersion = normaliseVersion(pathMatch[1]);
    if (pathVersion && API_VERSIONS[pathVersion]) return pathVersion;
  }

  // Priority 3: Query param (?version=v1)
  const queryVersion = normaliseVersion(req.query.version);
  if (queryVersion && API_VERSIONS[queryVersion]) return queryVersion;

  return LATEST_VERSION;
}

function apiVersionMiddleware(req, res, next) {
  // Avoid duplicate processing when mounted on both /api and /api/v1.
  if (req.apiVersion) return next();

  const version = resolveVersion(req);
  const versionConfig = API_VERSIONS[version];

  req.apiVersion = version;
  res.setHeader("X-API-Version", version);

  if (versionConfig.status === "deprecated") {
    res.setHeader("Deprecation", "true");
    if (versionConfig.sunsetAt) {
      res.setHeader("Sunset", new Date(versionConfig.sunsetAt).toUTCString());
    }
    logger.info(
      {
        event: "deprecated_api_usage",
        version,
        path: req.path,
        clientIp: req.ip,
      },
      "Deprecated API version used",
    );
    deprecationCounter.labels(version, req.path).inc();
  }

  if (
    versionConfig.status === "sunset" &&
    versionConfig.sunsetAt &&
    Date.now() > new Date(versionConfig.sunsetAt).getTime()
  ) {
    return res.status(410).json({
      error: `API ${version} has been sunset. Please upgrade to ${LATEST_VERSION}.`,
      latestVersion: LATEST_VERSION,
      migrationUrl: "/docs/api/migration",
      sunset: versionConfig.sunsetAt,
    });
  }

  return next();
}

function registerApiVersionDiscoveryRoutes(app) {
  app.get("/api/versions", (_req, res) => {
    res.json({
      success: true,
      data: {
        versions: Object.entries(API_VERSIONS).map(([version, config]) => ({
          version,
          status: config.status,
          releasedAt: config.releasedAt,
          deprecatedAt: config.deprecatedAt,
          sunsetAt: config.sunsetAt,
          path: config.path,
        })),
        latest: LATEST_VERSION,
      },
    });
  });

  app.get("/api/.well-known/apiversions", (_req, res) => {
    res.json({
      versions: Object.keys(API_VERSIONS),
      latest: LATEST_VERSION,
    });
  });
}

module.exports = {
  apiVersionMiddleware,
  deprecationCounter,
  registerApiVersionDiscoveryRoutes,
  resolveVersion,
};
