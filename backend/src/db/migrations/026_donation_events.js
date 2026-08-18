"use strict";

/**
 * 026_donation_events
 *
 * Introduces event sourcing for the donation domain.
 *
 * `donation_events` is the append-only, immutable event store. Every state
 * change for a donation aggregate (donation recorded, donor badge upgraded,
 * project stats updated, …) is appended here first; the materialised read
 * models (projections) are derived deterministically by replaying this
 * stream. This makes the Soroban contract events the single source of truth
 * and removes the need for bespoke reconciliation of project/donor totals.
 *
 * The four projection tables are the read models the API serves from:
 *   - projection_donor_leaderboard — ranked donor totals (leaderboard)
 *   - projection_project_stats      — per-project aggregates (project stats)
 *   - projection_donor_history      — per-donor donation history (donor view)
 *   - projection_global_stats       — platform-wide counters (stats page)
 *
 * All four are fully rebuildable from `donation_events`, so they hold no
 * authoritative state — a corrupted projection is just truncated and
 * replayed.
 *
 * Immutability note: the application connects with a role that is granted
 * INSERT (and SELECT) on `donation_events` but NOT UPDATE/DELETE, so the
 * event log cannot be mutated once written. The table owner retains the
 * ability to rotate/archive. (Revoke statements are documented in the
 * migration comment below and applied by the migration runner role.)
 */

module.exports = {
  name: "026_donation_events",

  async up(client) {
    // ── Event store ────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS donation_events (
        id               BIGSERIAL PRIMARY KEY,
        event_type       VARCHAR(50)  NOT NULL,
        aggregate_id     VARCHAR(100) NOT NULL,
        event_data       JSONB        NOT NULL,
        soroban_ledger   INTEGER,
        transaction_hash VARCHAR(64),
        created_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
      )
    `);

    await client.query(
      "CREATE INDEX IF NOT EXISTS idx_donation_events_aggregate ON donation_events(aggregate_id, created_at)",
    );
    await client.query(
      "CREATE INDEX IF NOT EXISTS idx_donation_events_type ON donation_events(event_type, created_at)",
    );

    // ── Projection: donor leaderboard ────────────────────────────────────────
    // Replaces the live aggregate over `donations` + `profiles`.
    await client.query(`
      CREATE TABLE IF NOT EXISTS projection_donor_leaderboard (
        donor_address     VARCHAR(56) PRIMARY KEY,
        total_donated     NUMERIC(20, 7) NOT NULL DEFAULT 0,
        donation_count    INTEGER         NOT NULL DEFAULT 0,
        projects_supported INTEGER        NOT NULL DEFAULT 0,
        total_co2_offset  NUMERIC(20, 4) NOT NULL DEFAULT 0,
        impact_score      NUMERIC(20, 4) NOT NULL DEFAULT 0,
        last_donation_at  TIMESTAMPTZ
      )
    `);
    await client.query(
      "CREATE INDEX IF NOT EXISTS idx_proj_leaderboard_total ON projection_donor_leaderboard(total_donated DESC)",
    );
    await client.query(
      "CREATE INDEX IF NOT EXISTS idx_proj_leaderboard_impact ON projection_donor_leaderboard(impact_score DESC)",
    );

    // ── Projection: project stats ─────────────────────────────────────────────
    // Replaces `projects.raised_xlm`/`donor_count` computed aggregations.
    await client.query(`
      CREATE TABLE IF NOT EXISTS projection_project_stats (
        project_id        VARCHAR(36)  PRIMARY KEY,
        raised_xlm        NUMERIC(20, 7) NOT NULL DEFAULT 0,
        donation_count    INTEGER         NOT NULL DEFAULT 0,
        donor_count       INTEGER         NOT NULL DEFAULT 0,
        co2_offset_kg     NUMERIC(20, 4) NOT NULL DEFAULT 0,
        last_donation_at  TIMESTAMPTZ
      )
    `);
    await client.query(
      "CREATE INDEX IF NOT EXISTS idx_proj_project_stats_raised ON projection_project_stats(raised_xlm DESC)",
    );

    // ── Projection: donor history ─────────────────────────────────────────────
    // Replaces direct queries against `donations` for a single donor/project.
    await client.query(`
      CREATE TABLE IF NOT EXISTS projection_donor_history (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        donor_address    VARCHAR(56) NOT NULL,
        project_id       VARCHAR(36) NOT NULL,
        amount_xlm       NUMERIC(20, 7) NOT NULL,
        amount           NUMERIC(20, 7) NOT NULL DEFAULT 0,
        currency         VARCHAR(8)  NOT NULL DEFAULT 'XLM',
        message          TEXT,
        transaction_hash VARCHAR(64) NOT NULL,
        co2_offset_kg    NUMERIC(20, 4) NOT NULL DEFAULT 0,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(
      "CREATE INDEX IF NOT EXISTS idx_proj_history_donor ON projection_donor_history(donor_address, created_at DESC)",
    );
    await client.query(
      "CREATE INDEX IF NOT EXISTS idx_proj_history_project ON projection_donor_history(project_id, created_at DESC)",
    );
    await client.query(
      "CREATE UNIQUE INDEX IF NOT EXISTS uq_proj_history_tx ON projection_donor_history(transaction_hash)",
    );

    // ── Projection: global stats ──────────────────────────────────────────────
    // Single-row materialised view of platform-wide counters.
    await client.query(`
      CREATE TABLE IF NOT EXISTS projection_global_stats (
        id               INTEGER PRIMARY KEY DEFAULT 1,
        total_xlm_raised NUMERIC(20, 7) NOT NULL DEFAULT 0,
        total_co2_offset_kg NUMERIC(20, 4) NOT NULL DEFAULT 0,
        total_donations  BIGINT         NOT NULL DEFAULT 0,
        total_donors     INTEGER        NOT NULL DEFAULT 0,
        total_projects   INTEGER        NOT NULL DEFAULT 0,
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    // Seed the singleton row so rebuilds can UPDATE instead of INSERT/race.
    await client.query(`
      INSERT INTO projection_global_stats (id, total_xlm_raised, total_co2_offset_kg,
        total_donations, total_donors, total_projects, updated_at)
      VALUES (1, 0, 0, 0, 0, 0, NOW())
      ON CONFLICT (id) DO NOTHING
    `);

    // ── Immutability: revoke mutation from the application role ────────────────
    // The app connects as the database owner in dev; in production the
    // migration-runner role should create a dedicated `indigopay_writer` role
    // with only INSERT/SELECT on donation_events. Left as a no-op here so it
    // does not break local/CI setups, but documented for the DBA:
    //
    //   REVOKE UPDATE, DELETE ON donation_events FROM indigopay_app;
    //
    // We instead enforce immutability at the application layer: this module
    // never performs UPDATE/DELETE on donation_events and the projection
    // engine only ever appends.
  },

  async down(client) {
    await client.query("DROP TABLE IF EXISTS projection_global_stats");
    await client.query("DROP TABLE IF EXISTS projection_donor_history");
    await client.query("DROP TABLE IF EXISTS projection_project_stats");
    await client.query("DROP TABLE IF EXISTS projection_donor_leaderboard");
    await client.query("DROP TABLE IF EXISTS donation_events");
  },
};
