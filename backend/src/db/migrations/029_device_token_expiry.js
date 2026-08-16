"use strict";

/**
 * 029_device_token_expiry
 *
 * Push-token lifecycle hardening (closes #717):
 *
 *   - device_tokens.expires_at — sliding expiry window (default 180 days)
 *     refreshed on every register. A NULL value means "never expires" and is
 *     backward compatible with pre-existing rows. Expired tokens are excluded
 *     from push sends and soft-deactivated by purgeExpiredTokens().
 *
 *   - uq_device_tokens_wallet_token — explicit per-user+device uniqueness:
 *     a wallet may hold the same physical device token under at most one row.
 *     The token column is already globally UNIQUE; this partial index makes
 *     the per-user+device guarantee explicit and serves the send-path lookup
 *     on (wallet_address, token).
 *
 *   - idx_device_tokens_expiry — supports the periodic purge of expired tokens
 *     and the expiry filter on the send paths.
 */
module.exports = {
  name: "029_device_token_expiry",

  async up(client) {
    await client.query(`
      ALTER TABLE device_tokens
      ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_device_tokens_wallet_token
      ON device_tokens (wallet_address, token)
      WHERE wallet_address IS NOT NULL
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_device_tokens_expiry
      ON device_tokens (expires_at)
      WHERE expires_at IS NOT NULL
    `);
  },

  async down(client) {
    await client.query("DROP INDEX IF EXISTS idx_device_tokens_expiry");
    await client.query("DROP INDEX IF EXISTS uq_device_tokens_wallet_token");
    await client.query(
      "ALTER TABLE device_tokens DROP COLUMN IF EXISTS expires_at",
    );
  },
};
