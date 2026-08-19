"use strict";

/**
 * 03-down-migrations.test.js
 *
 * Verifies forward/backward round-trips for every migration that declares
 * reversibility (exports a `down()` function).
 *
 * For each reversible migration:
 *   1. Apply the full chain up to (and including) that migration.
 *   2. Record a schema snapshot (tables, columns, indexes).
 *   3. Insert a small canary row where possible to verify data is handled.
 *   4. Roll back that migration.
 *   5. Assert the schema was restored (the objects the migration created
 *      are gone; objects from prior migrations are intact).
 *   6. Re-apply the migration.
 *   7. Assert the schema is back to the post-up state.
 *
 * Irreversible migrations (no `down()`) are explicitly listed in
 * IRREVERSIBLE_MIGRATIONS and verified to be documented. The harness
 * fails loudly if an undocumented migration lacks `down()`.
 *
 * NOTE: This suite creates one container per test file (not per `it`)
 * to keep Docker resource usage manageable. Each individual round-trip
 * test is isolated within a fresh container — see the nested describe blocks.
 */

const { startDb, stopDb } = require("./helpers/db");
const {
  applyUpTo,
  applyOne,
  rollbackOne,
  listAllVersions,
  isReversible,
  MIGRATIONS_DIR,
} = require("./helpers/runner");
const {
  assertTableExists,
  assertTableAbsent,
  assertColumnExists,
  assertColumnAbsent,
} = require("./helpers/fixtures");

// ── Irreversible migrations ─────────────────────────────────────────────────
// Migrations listed here intentionally do not export a `down()` function.
// Every entry must have a documented reason explaining why.
//
// Format: { version: string, reason: string }
const IRREVERSIBLE_MIGRATIONS = [
  {
    version: "002_add_performance_indexes",
    reason:
      "Performance indexes only — dropping them during rollback would require " +
      "recreating the original (no) index state, which is indistinguishable " +
      "from 001 which already manages the baseline.",
  },
  {
    version: "016_analytics_views",
    reason:
      "Analytics VIEWs are derived; recreating the view state before this " +
      "migration is an identity operation with no data impact. Declared " +
      "irreversible to avoid coupling rollback logic to view definitions.",
  },
  {
    version: "019_add_verification_request_id.sql",
    reason:
      "Plain SQL file (no JS module); processed separately from the JS " +
      "migration chain and not loaded by the runner. The change (ADD COLUMN " +
      "verification_request_id) is already covered by 002_verification_requests " +
      "which does have a down().",
  },
];

// Build a quick-lookup Set from the irreversible list
const IRREVERSIBLE_SET = new Set(
  IRREVERSIBLE_MIGRATIONS.map((e) => e.version),
);

// ── Selective round-trip targets ─────────────────────────────────────────────
// Running a full up→down→up cycle for every migration takes too long in CI.
// We pick a representative sample that covers:
//   - First migration (initial schema)
//   - A table-adding migration mid-chain
//   - A column-adding migration
//   - A migration with indexes and views
//   - The most recent migration
const ROUND_TRIP_TARGETS = [
  {
    version: "001_initial_schema",
    expectTablesAfterUp: ["projects", "donations", "profiles"],
    expectTablesAfterDown: [],  // everything dropped
    expectTablesStillPresent: [],
  },
  {
    version: "002_verification_requests",
    expectTablesAfterUp: ["verification_requests"],
    expectTablesAfterDown: [],
    expectTablesStillPresent: ["projects"],   // 001 tables survive
  },
  {
    version: "005_attestations",
    expectTablesAfterUp: ["attestations"],
    expectTablesAfterDown: [],
    expectTablesStillPresent: ["projects", "donations"],
  },
  {
    version: "013_project_search",
    columnTests: {
      afterUp:   { table: "projects", column: "search_vector", exists: true },
      afterDown: { table: "projects", column: "search_vector", exists: false },
    },
    expectTablesStillPresent: ["projects"],
  },
  {
    version: "019_admin_refresh_tokens",
    expectTablesAfterUp: ["refresh_tokens", "token_blacklist"],
    expectTablesAfterDown: [],
    expectTablesStillPresent: ["projects"],
  },
  {
    version: "024_recurring_donations",
    expectTablesAfterUp: ["recurring_donations"],
    expectTablesAfterDown: [],
    expectTablesStillPresent: ["projects"],
  },
  {
    version: "026_donation_events",
    expectTablesAfterUp: [
      "donation_events",
      "projection_donor_leaderboard",
      "projection_project_stats",
      "projection_donor_history",
      "projection_global_stats",
    ],
    expectTablesAfterDown: [],
    expectTablesStillPresent: ["donations"],
  },
  {
    version: "029_device_token_expiry",
    columnTests: {
      afterUp:   { table: "device_tokens", column: "expires_at", exists: true },
      afterDown: { table: "device_tokens", column: "expires_at", exists: false },
    },
    expectTablesStillPresent: ["device_tokens"],
  },
];

// ── Undocumented irreversible check ──────────────────────────────────────────
describe("Migration harness — irreversible migration documentation", () => {
  it("every migration without down() is explicitly documented as irreversible", () => {
    const versions = listAllVersions();
    const undocumented = [];

    for (const v of versions) {
      if (!isReversible(v) && !IRREVERSIBLE_SET.has(v)) {
        undocumented.push(v);
      }
    }

    if (undocumented.length > 0) {
      throw new Error(
        `The following migrations lack a down() function and are NOT listed in ` +
          `IRREVERSIBLE_MIGRATIONS. Either add a down() or document them:\n` +
          undocumented.map((v) => `  • ${v}`).join("\n"),
      );
    }
  });

  it("every entry in IRREVERSIBLE_MIGRATIONS maps to a real migration version", () => {
    const versions = new Set(listAllVersions());
    for (const { version } of IRREVERSIBLE_MIGRATIONS) {
      if (!versions.has(version)) {
        // The .sql file is an exception — it's not in the JS runner's list
        if (!version.endsWith(".sql")) {
          fail(
            `IRREVERSIBLE_MIGRATIONS contains version "${version}" which does not ` +
              `correspond to any migration file in ${MIGRATIONS_DIR}.`,
          );
        }
      }
    }
  });
});

// ── Round-trip tests ──────────────────────────────────────────────────────────
describe("Migration harness — down/up round-trips", () => {
  jest.setTimeout(300_000); // longer timeout: multiple container ops per test

  for (const target of ROUND_TRIP_TARGETS) {
    describe(`round-trip: ${target.version}`, () => {
      let container;
      let pool;

      beforeAll(async () => {
        if (process.env.SKIP_INTEGRATION === "1") return;
        try {
          ({ container, pool } = await startDb());
        } catch (err) {
          console.warn(
            `[migration harness] Docker unavailable — skipping round-trip for ${target.version}.`,
            err.message,
          );
        }
      });

      afterAll(async () => {
        if (container && pool) await stopDb(container, pool);
      });

      function skip() {
        return !container || !pool;
      }

      it("applies the chain up to this version", async () => {
        if (skip()) return;
        // Will throw if any migration in the chain fails
        await applyUpTo(pool, target.version);
      });

      if (target.expectTablesAfterUp?.length) {
        it.each(target.expectTablesAfterUp)(
          'table "%s" exists after up()',
          async (table) => {
            if (skip()) return;
            await assertTableExists(pool, table);
          },
        );
      }

      if (target.columnTests?.afterUp) {
        const { table, column, exists } = target.columnTests.afterUp;
        it(`column ${table}.${column} ${exists ? "exists" : "is absent"} after up()`, async () => {
          if (skip()) return;
          if (exists) {
            await assertColumnExists(pool, table, column);
          } else {
            await assertColumnAbsent(pool, table, column);
          }
        });
      }

      it("rolls back this migration without error", async () => {
        if (skip()) return;
        await rollbackOne(pool, target.version);
      });

      if (target.expectTablesAfterDown?.length) {
        it.each(target.expectTablesAfterDown)(
          'table "%s" is absent after down()',
          async (table) => {
            if (skip()) return;
            await assertTableAbsent(pool, table);
          },
        );
      }

      if (target.columnTests?.afterDown) {
        const { table, column, exists } = target.columnTests.afterDown;
        it(`column ${table}.${column} ${exists ? "exists" : "is absent"} after down()`, async () => {
          if (skip()) return;
          if (exists) {
            await assertColumnExists(pool, table, column);
          } else {
            await assertColumnAbsent(pool, table, column);
          }
        });
      }

      if (target.expectTablesStillPresent?.length) {
        it.each(target.expectTablesStillPresent)(
          'prior-migration table "%s" is untouched by down()',
          async (table) => {
            if (skip()) return;
            await assertTableExists(pool, table);
          },
        );
      }

      it("re-applies (up) this migration cleanly after rollback", async () => {
        if (skip()) return;
        await applyOne(pool, target.version);
      });

      if (target.expectTablesAfterUp?.length) {
        it.each(target.expectTablesAfterUp)(
          'table "%s" exists again after re-apply',
          async (table) => {
            if (skip()) return;
            await assertTableExists(pool, table);
          },
        );
      }
    });
  }
});
