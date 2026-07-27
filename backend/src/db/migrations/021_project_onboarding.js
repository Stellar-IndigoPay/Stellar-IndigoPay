"use strict";

module.exports = {
  name: "021_project_onboarding",

  async up(client) {
    await client.query(`
      ALTER TABLE projects
      ADD COLUMN IF NOT EXISTS verification_request_id UUID;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS project_onboarding (
        project_id UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        items JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION project_onboarding_updated_at()
      RETURNS trigger AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await client.query(`
      DROP TRIGGER IF EXISTS project_onboarding_updated_at_trigger ON project_onboarding;
      CREATE TRIGGER project_onboarding_updated_at_trigger
      BEFORE UPDATE ON project_onboarding
      FOR EACH ROW EXECUTE FUNCTION project_onboarding_updated_at();
    `);
  },

  async down(client) {
    await client.query(`
      DROP TRIGGER IF EXISTS project_onboarding_updated_at_trigger ON project_onboarding;
    `);
    await client.query(`
      DROP FUNCTION IF EXISTS project_onboarding_updated_at();
    `);
    await client.query(`
      DROP TABLE IF EXISTS project_onboarding;
    `);
  },
};
