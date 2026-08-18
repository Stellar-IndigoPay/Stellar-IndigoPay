"use strict";

module.exports = {
  name: "006_notification_preferences",

  async up(client) {
    await client.query(`
      ALTER TABLE notification_preferences
        ADD COLUMN IF NOT EXISTS project_id TEXT
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_prefs_project
      ON notification_preferences(wallet_address, project_id, channel)
      WHERE project_id IS NOT NULL
    `);
  },

  async down(client) {
    await client.query(
      "DROP INDEX IF EXISTS idx_notification_prefs_project",
    );
    await client.query(
      "ALTER TABLE notification_preferences DROP COLUMN IF EXISTS project_id",
    );
  },
};
