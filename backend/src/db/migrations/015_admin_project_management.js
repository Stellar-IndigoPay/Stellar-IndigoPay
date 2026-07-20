"use strict";

/**
 * Records who and when an administrator soft-deactivated a project. Keeping
 * these fields on the row allows the project to be restored without losing
 * its donations, verification history, or public identifier.
 */
module.exports = {
  name: "015_admin_project_management",

  async up(client) {
    await client.query(
      "ALTER TABLE projects ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ",
    );
    await client.query(
      "ALTER TABLE projects ADD COLUMN IF NOT EXISTS deactivated_by TEXT",
    );
    await client.query(
      "CREATE INDEX IF NOT EXISTS idx_projects_admin_status_category ON projects (status, category)",
    );
  },

  async down(client) {
    await client.query(
      "DROP INDEX IF EXISTS idx_projects_admin_status_category",
    );
    await client.query(
      "ALTER TABLE projects DROP COLUMN IF EXISTS deactivated_by",
    );
    await client.query(
      "ALTER TABLE projects DROP COLUMN IF EXISTS deactivated_at",
    );
  },
};
