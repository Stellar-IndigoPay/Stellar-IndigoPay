"use strict";

/**
 * 030_ai_summary_cache
 *
 * Deterministic cache for AI-generated project summaries (issue #929).
 *
 * `cache_key = sha256(template_version || model || input_hash)` is the
 * primary key: identical inputs against the same prompt template version
 * and model always resolve to the same row, so a repeat request is served
 * from this table with no provider call. A changed input (different
 * description) produces a different `input_hash` and therefore a new row
 * — the previous row for the same project is kept (not overwritten) so
 * there's an audit trail of what was generated for which inputs.
 */
module.exports = {
  name: "030_ai_summary_cache",

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_summary_cache (
        cache_key        TEXT PRIMARY KEY,
        project_id       UUID REFERENCES projects(id) ON DELETE CASCADE,
        template_version TEXT NOT NULL,
        model            TEXT NOT NULL,
        input_hash       TEXT NOT NULL,
        summary          TEXT NOT NULL,
        input_tokens     INTEGER,
        output_tokens    INTEGER,
        cost_usd         NUMERIC(10, 6),
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_ai_summary_cache_project_created
      ON ai_summary_cache(project_id, created_at DESC)
    `);
  },

  async down(client) {
    await client.query("DROP TABLE IF EXISTS ai_summary_cache");
  },
};
