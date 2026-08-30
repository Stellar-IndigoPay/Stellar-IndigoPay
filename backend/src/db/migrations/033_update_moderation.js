"use strict";

/**
 * 033_update_moderation
 *
 * Content-moderation pipeline for project updates (issue #935).
 *
 * Adds moderation state columns to `project_updates` so every update
 * carries its full screening/decision trail alongside the public row:
 *
 *   moderation_status      pending-screening | live | quarantined | removed
 *   moderation_screening   JSONB rule/AI screening result (hits, confidence,
 *                          verdict, model, template version, ai outcome)
 *   moderation_screened_at when the automated pipeline last ran
 *   moderation_reviewed_by / moderation_reviewed_at / moderation_rationale
 *                          the admin decision trail (reviewer identity is
 *                          anchored in admin_audit_log as well)
 *   moderation_alerted     set once a hard violation raised an alert
 *
 * Backfill: pre-existing rows (seed + prod data) are promoted to `live` so
 * the roll-out does not hide historical updates that were never screened.
 * The public read path filters on moderation_status = 'live', so anything
 * still stuck at the backfill default would silently vanish.
 *
 * New tables:
 *   update_abuse_reports   follower abuse reports, deduped per
 *                          (update_id, reporter) so one reporter can only
 *                          file one report per update.
 *   ai_moderation_cache    deterministic cache for the AI screening call:
 *                          cache_key = sha256(template_version || model ||
 *                          input_hash), identical inputs never hit the
 *                          provider twice.
 */
module.exports = {
  name: "033_update_moderation",

  async up(client) {
    await client.query(`
      ALTER TABLE project_updates
        ADD COLUMN IF NOT EXISTS moderation_status TEXT NOT NULL DEFAULT 'pending-screening'
          CHECK (moderation_status IN ('pending-screening', 'live', 'quarantined', 'removed'))
    `);
    await client.query(`
      ALTER TABLE project_updates
        ADD COLUMN IF NOT EXISTS moderation_screening JSONB
    `);
    await client.query(`
      ALTER TABLE project_updates
        ADD COLUMN IF NOT EXISTS moderation_screened_at TIMESTAMPTZ
    `);
    await client.query(`
      ALTER TABLE project_updates
        ADD COLUMN IF NOT EXISTS moderation_reviewed_by TEXT
    `);
    await client.query(`
      ALTER TABLE project_updates
        ADD COLUMN IF NOT EXISTS moderation_reviewed_at TIMESTAMPTZ
    `);
    await client.query(`
      ALTER TABLE project_updates
        ADD COLUMN IF NOT EXISTS moderation_rationale TEXT
    `);
    await client.query(`
      ALTER TABLE project_updates
        ADD COLUMN IF NOT EXISTS moderation_alerted BOOLEAN NOT NULL DEFAULT FALSE
    `);

    // Historical rows were never screened; keep them publicly visible rather
    // than losing them to the read-path filter.
    await client.query(`
      UPDATE project_updates SET moderation_status = 'live'
       WHERE moderation_status = 'pending-screening'
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_project_updates_moderation
      ON project_updates(project_id, moderation_status, created_at DESC)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS update_abuse_reports (
        id          UUID PRIMARY KEY,
        update_id   UUID NOT NULL REFERENCES project_updates(id) ON DELETE CASCADE,
        reporter    TEXT NOT NULL,
        reason      TEXT,
        ip_hash     TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(update_id, reporter)
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_update_abuse_reports_update
      ON update_abuse_reports(update_id, created_at DESC)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_moderation_cache (
        cache_key        TEXT PRIMARY KEY,
        update_id        UUID REFERENCES project_updates(id) ON DELETE CASCADE,
        template_version TEXT NOT NULL,
        model            TEXT NOT NULL,
        input_hash       TEXT NOT NULL,
        verdict          TEXT NOT NULL,
        confidence       NUMERIC(5, 4) NOT NULL,
        rationale        TEXT,
        input_tokens     INTEGER,
        output_tokens    INTEGER,
        cost_usd         NUMERIC(10, 6),
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  },

  async down(client) {
    await client.query("DROP TABLE IF EXISTS ai_moderation_cache");
    await client.query("DROP TABLE IF EXISTS update_abuse_reports");
    await client.query(
      "DROP INDEX IF EXISTS idx_project_updates_moderation",
    );
    await client.query(
      "DROP INDEX IF EXISTS idx_update_abuse_reports_update",
    );
    await client.query(
      "ALTER TABLE project_updates DROP COLUMN IF EXISTS moderation_status",
    );
    await client.query(
      "ALTER TABLE project_updates DROP COLUMN IF EXISTS moderation_screening",
    );
    await client.query(
      "ALTER TABLE project_updates DROP COLUMN IF EXISTS moderation_screened_at",
    );
    await client.query(
      "ALTER TABLE project_updates DROP COLUMN IF EXISTS moderation_reviewed_by",
    );
    await client.query(
      "ALTER TABLE project_updates DROP COLUMN IF EXISTS moderation_reviewed_at",
    );
    await client.query(
      "ALTER TABLE project_updates DROP COLUMN IF EXISTS moderation_rationale",
    );
    await client.query(
      "ALTER TABLE project_updates DROP COLUMN IF EXISTS moderation_alerted",
    );
  },
};