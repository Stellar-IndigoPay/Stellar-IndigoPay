"use strict";

/**
 * 021_push_provider_prefs
 *
 * Adds provider-routing columns so push notifications can be routed to
 * the correct provider (APNs for iOS, FCM for Android, Expo as fallback):
 *
 *   device_tokens.platform        — 'ios' | 'android' | 'web' — populated
 *                                   by the mobile client on registration.
 *                                   Already sent in the POST body; this
 *                                   migration just persists it.
 *
 *   push_notifications.platform   — snapshot of the device platform at
 *                                   send time for audit purposes.
 *
 *   push_notifications.provider   — which provider actually sent the
 *                                   notification ('apns'|'fcm'|'expo').
 *
 *   push_notifications.provider_preference
 *                                 — per-record routing override:
 *                                   'auto' = use platform default
 *                                   'expo' = force Expo Push
 *                                   'apns' = force APNs
 *                                   'fcm'  = force FCM
 *
 * Existing rows keep NULL for the new columns and are treated as 'auto'.
 */
module.exports = {
  name: "021_push_provider_prefs",

  async up(client) {
    // ── device_tokens: store the device platform ─────────────────────────
    await client.query(`
      ALTER TABLE device_tokens
        ADD COLUMN IF NOT EXISTS platform TEXT
    `);

    // ── push_notifications: snapshot + routing columns ───────────────────
    await client.query(`
      ALTER TABLE push_notifications
        ADD COLUMN IF NOT EXISTS platform            TEXT,
        ADD COLUMN IF NOT EXISTS provider            TEXT,
        ADD COLUMN IF NOT EXISTS provider_preference VARCHAR(20) DEFAULT 'auto'
    `);

    // Add CHECK constraint on provider_preference (safe; existing NULLs pass).
    await client.query(`
      ALTER TABLE push_notifications
        ADD CONSTRAINT IF NOT EXISTS push_notifications_provider_pref_check
        CHECK (provider_preference IN ('auto', 'expo', 'apns', 'fcm'))
    `);

    // Composite index used by the provider selection query:
    // WHERE platform = $1 AND provider_preference IN ('auto', <platform>)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_push_platform
        ON push_notifications(platform, provider_preference)
    `);

    // Index for provider-level metrics queries.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_push_provider
        ON push_notifications(provider, created_at DESC)
    `);
  },

  async down(client) {
    await client.query("DROP INDEX IF EXISTS idx_push_provider");
    await client.query("DROP INDEX IF EXISTS idx_push_platform");
    await client.query(`
      ALTER TABLE push_notifications
        DROP CONSTRAINT IF EXISTS push_notifications_provider_pref_check,
        DROP COLUMN IF EXISTS provider_preference,
        DROP COLUMN IF EXISTS provider,
        DROP COLUMN IF EXISTS platform
    `);
    await client.query(`
      ALTER TABLE device_tokens
        DROP COLUMN IF EXISTS platform
    `);
  },
};
