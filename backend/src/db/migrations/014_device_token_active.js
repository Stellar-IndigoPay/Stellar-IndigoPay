"use strict";

/**
 * 014_device_token_active
 *
 * Adds is_active boolean to device_tokens so the push service can skip
 * stale/invalidated tokens without deleting them (preserving audit trail).
 * Also adds notification_dnd JSONB column to profiles for Do Not Disturb
 * scheduling (mobile notification preferences).
 */
module.exports = {
  name: "014_device_token_active",

  async up(client) {
    await client.query(`
      ALTER TABLE device_tokens
      ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_device_tokens_active
      ON device_tokens(wallet_address, is_active)
      WHERE is_active = true
    `);

    await client.query(`
      ALTER TABLE profiles
      ADD COLUMN IF NOT EXISTS notification_dnd JSONB
    `);
  },

  async down(client) {
    await client.query(
      `ALTER TABLE device_tokens DROP COLUMN IF EXISTS is_active`,
    );
    await client.query(
      `ALTER TABLE profiles DROP COLUMN IF EXISTS notification_dnd`,
    );
  },
};
