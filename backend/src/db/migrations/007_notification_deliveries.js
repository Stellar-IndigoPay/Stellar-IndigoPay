"use strict";

module.exports = {
  name: "007_notification_deliveries",

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS notification_deliveries (
        id              UUID PRIMARY KEY,
        notification_id TEXT NOT NULL,
        recipient       TEXT NOT NULL,
        channel         TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'pending',
        provider_id     TEXT,
        error           TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_notification_deliveries_lookup
      ON notification_deliveries(notification_id, recipient)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_notification_deliveries_rate_limit
      ON notification_deliveries(recipient, notification_id, created_at DESC)
    `);
  },

  async down(client) {
    await client.query("DROP TABLE IF EXISTS notification_deliveries");
  },
};
