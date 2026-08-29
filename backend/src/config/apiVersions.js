"use strict";

/**
 * src/config/apiVersions.js
 *
 * Central registry for all API version lifecycles (issue #1128 Part B).
 *
 * Version lifecycle states
 * ─────────────────────────
 *   preview     — available but not yet stable; may change without notice
 *   active      — stable, fully supported
 *   deprecated  — still functional; consumers should migrate before sunsetAt
 *   sunset      — rejected with HTTP 410 Gone once sunsetAt is past
 *
 * Required fields for each version
 * ──────────────────────────────────
 *   status          — one of the states above
 *   releasedAt      — ISO-8601 date the version became available
 *   path            — URL prefix for this version
 *
 * Optional fields
 * ───────────────
 *   deprecatedAt        — ISO-8601 date deprecation was announced
 *   sunsetAt            — ISO-8601 date the version will be removed
 *   successorPath       — URL of the preferred replacement (e.g. "/api/v2")
 *   migrationUrl        — Link to the migration guide
 *   deprecationMessage  — Custom warning text injected into response bodies
 *                         (falls back to a generated message when omitted)
 *   docsUrl             — Link to the version-specific API reference
 *
 * GET /api/versions returns all entries in this map.
 * The apiVersionMiddleware injects Deprecation / Sunset / Link headers and
 * a body-level warning for any version whose status is "deprecated".
 */

const API_VERSIONS = {
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
  // Uncomment and adjust when v2 ships:
  // v2: {
  //   status: "preview",
  //   releasedAt: "2027-01-01",
  //   deprecatedAt: null,
  //   sunsetAt: null,
  //   path: "/api/v2",
  //   successorPath: null,
  //   migrationUrl: "/docs/api/migration-v2",
  //   deprecationMessage: null,
  //   docsUrl: "/api/docs#tag/v2",
  // },
};

const LATEST_VERSION = "v1";

module.exports = { API_VERSIONS, LATEST_VERSION };
