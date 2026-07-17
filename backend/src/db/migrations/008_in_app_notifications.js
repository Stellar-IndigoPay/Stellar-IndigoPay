"use strict";

module.exports = {
  name: "008_in_app_notifications",

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS in_app_notifications (
        id             UUID PRIMARY KEY,
        wallet_address TEXT NOT NULL,
        title          TEXT NOT NULL,
        body           TEXT NOT NULL,
        data           JSONB,
        read           BOOLEAN NOT NULL DEFAULT FALSE,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_in_app_notifications_wallet
      ON in_app_notifications(wallet_address, created_at DESC)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_in_app_notifications_unread
      ON in_app_notifications(wallet_address) WHERE read = FALSE
    `);
  },

  async down(client) {
    await client.query("DROP TABLE IF EXISTS in_app_notifications");
  },
};
