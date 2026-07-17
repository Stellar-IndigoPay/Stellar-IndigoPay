"use strict";

module.exports = {
  name: "018_upload_quotas",

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS project_uploads (
        id UUID PRIMARY KEY,
        project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
        storage_key TEXT NOT NULL,
        original_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes BIGINT NOT NULL,
        sha256_hash TEXT NOT NULL,
        uploaded_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Add an index on project_id for quota calculations
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_project_uploads_project_id
      ON project_uploads(project_id)
    `);
    
    // Add an index on sha256_hash for deduplication checks within a project
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_project_uploads_hash_project
      ON project_uploads(project_id, sha256_hash)
    `);
  },

  async down(client) {
    await client.query("DROP INDEX IF EXISTS idx_project_uploads_hash_project");
    await client.query("DROP INDEX IF EXISTS idx_project_uploads_project_id");
    await client.query("DROP TABLE IF EXISTS project_uploads");
  },
};
