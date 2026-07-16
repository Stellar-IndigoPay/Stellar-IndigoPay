"use strict";

/**
 * 005_push_notifications
 *
 * Adds the tables needed to actually send and track push notifications
 * (GF-049). `device_tokens` and `project_follows` already existed —
 * this migration adds:
 *
 *   - notification_preferences: per-wallet, per-channel opt-outs. A row
 *     with type = NULL is a blanket preference for the channel; a row
 *     with a specific type overrides the blanket one for that type. No
 *     row at all means "opted in" (push defaults to on). Two partial
 *     unique indexes stand in for a single UNIQUE constraint since
 *     Postgres treats NULL as distinct in a regular unique constraint.
 *
 *   - push_notifications: one row per Expo push ticket attempt, so
 *     deliveries can be audited and invalid tokens aren't silently
 *     retried forever. wallet_address is nullable because project
 *     updates broadcast to anonymous (wallet-less) device follows too.
 */
module.exports = {
  name: "005_push_notifications",

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS notification_preferences (
        id             UUID PRIMARY KEY,
        wallet_address TEXT NOT NULL,
        channel        TEXT NOT NULL,
        type           TEXT,
        enabled        BOOLEAN NOT NULL DEFAULT TRUE,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_prefs_specific
      ON notification_preferences(wallet_address, channel, type)
      WHERE type IS NOT NULL
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_prefs_blanket
      ON notification_preferences(wallet_address, channel)
      WHERE type IS NULL
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS push_notifications (
        id             UUID PRIMARY KEY,
        wallet_address TEXT,
        device_token   TEXT NOT NULL,
        title          TEXT NOT NULL,
        body           TEXT NOT NULL,
        data           JSONB,
        status         TEXT NOT NULL DEFAULT 'sent',
        ticket_id      TEXT,
        error_message  TEXT,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT push_notifications_status_check CHECK (
          status IN ('sent', 'delivered', 'failed')
        )
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_push_notifications_wallet
      ON push_notifications(wallet_address)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_push_notifications_status
      ON push_notifications(status)
    `);
  },

  async down(client) {
    await client.query(`DROP TABLE IF EXISTS push_notifications`);
    await client.query(`DROP TABLE IF EXISTS notification_preferences`);
  },
};
