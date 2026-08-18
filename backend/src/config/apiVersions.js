"use strict";

const API_VERSIONS = {
  v1: {
    status: "active",
    releasedAt: "2026-01-01",
    deprecatedAt: null,
    sunsetAt: null,
    path: "/api/v1",
  },
  // Future:
  // v2: {
  //   status: "preview",
  //   releasedAt: "2027-01-01",
  //   deprecatedAt: null,
  //   sunsetAt: null,
  //   path: "/api/v2",
  // },
};

const LATEST_VERSION = "v1";

module.exports = { API_VERSIONS, LATEST_VERSION };
