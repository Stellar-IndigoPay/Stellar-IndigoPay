"use strict";

/**
 * 004_ai_prompt_versions
 *
 * Adds two tables for the AI summarisation pipeline:
 *
 *   - prompt_versions: every version of the system prompt and target
 *     model. Exactly one row is `active = TRUE` at a time. The active
 *     row is the canonical source of truth for the system prompt.
 *
 *   - ai_summary_calls: per-project, per-day call log so the
 *     /api/projects/:id/generate-summary route can enforce a soft
 *     per-project daily quota without a cron job.
 */
module.exports = {
  name: "004_ai_prompt_versions",

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS prompt_versions (
        id           UUID PRIMARY KEY,
        slug         TEXT NOT NULL UNIQUE,
        body         TEXT NOT NULL,
        model        TEXT NOT NULL,
        active       BOOLEAN NOT NULL DEFAULT FALSE,
        created_by   TEXT,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        activated_at TIMESTAMPTZ
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_versions_one_active
      ON prompt_versions (active) WHERE active = TRUE
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_summary_calls (
        id          UUID PRIMARY KEY,
        project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        called_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        requested_by TEXT,
        outcome     TEXT NOT NULL DEFAULT 'queued',
        prompt_version_id UUID REFERENCES prompt_versions(id) ON DELETE SET NULL
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_ai_summary_calls_project_called
      ON ai_summary_calls(project_id, called_at DESC)
    `);
  },

  async down(client) {
    await client.query(`DROP TABLE IF EXISTS ai_summary_calls`);
    await client.query(`DROP TABLE IF EXISTS prompt_versions`);
  },
};
