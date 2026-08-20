"use strict";

/**
 * 037_add_verification_request_id
 *
 * Adds the verification_request_id foreign key column to the projects table,
 * linking a project to the verification_requests row that approved it.
 *
 * Originally authored as a .sql file (019_add_verification_request_id.sql)
 * which the migrate.js runner could not load (it only reads .js files).
 * Converted to a .js migration and renumbered to 037 to avoid the duplicate
 * 019_ prefix conflict with 019_admin_refresh_tokens.js.
 */
module.exports = {
  name: "037_add_verification_request_id",

  async up(client) {
    await client.query(`
      ALTER TABLE projects
      ADD COLUMN IF NOT EXISTS verification_request_id UUID
        REFERENCES verification_requests(id)
    `);
  },

  async down(client) {
    await client.query(`
      ALTER TABLE projects
      DROP COLUMN IF EXISTS verification_request_id
    `);
  },
};
