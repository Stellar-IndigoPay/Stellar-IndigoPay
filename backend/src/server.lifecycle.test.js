"use strict";

const fs = require("fs");
const path = require("path");

const serverSource = fs.readFileSync(
  path.join(__dirname, "server.js"),
  "utf8",
);

const STARTED_SERVICES = [
  "summary_queue",
  "profile_queue",
  "match_queue",
  "webhook_queue",
  "push_queue",
  "impact_queue",
  "idempotency_cleanup",
  "recurring_donation_worker",
  "blacklist_cleanup",
  "co2_verification_cron",
  "match_expiry",
  "retention_worker",
  "digest_queue",
  "dsr_queue",
  "indexer",
  "indexer_reconciler",
  "indexer_dlq_worker",
  "oracle_service",
  "guardian_service",
  "recurring_keeper",
  "soroban_events",
  "socket_io",
  "database_pool",
  "redis",
  "sentry",
  "db_pool_metrics",
  "turrets_server",
];

function configuredNames() {
  return [...serverSource.matchAll(/\bname:\s*"([a-z0-9_]+)"/g)].map(
    ([, name]) => name,
  );
}

function configurationFor(name, allNames) {
  const start = serverSource.indexOf(`name: "${name}"`);
  const laterNames = allNames
    .map((candidate) => serverSource.indexOf(`name: "${candidate}"`, start + 1))
    .filter((index) => index > start);
  const end = laterNames.length > 0 ? Math.min(...laterNames) : serverSource.length;
  return serverSource.slice(Math.max(0, start - 120), end);
}

describe("server lifecycle registration", () => {
  test("accounts for every expected service and resource exactly once", () => {
    const names = configuredNames();
    const expected = [...STARTED_SERVICES].sort();

    expect(names.sort()).toEqual(expected);
    expect(new Set(names).size).toBe(names.length);
  });

  test.each(STARTED_SERVICES)(
    "%s has managed startup and shutdown",
    (name) => {
      const block = configurationFor(name, configuredNames());

      expect(block).toMatch(/start(?:Optional|Managed)Worker\(\{/);
      expect(block).toMatch(/\bstop:/);
    },
  );
});
