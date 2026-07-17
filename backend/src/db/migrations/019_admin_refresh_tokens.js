/**
 * 019_admin_refresh_tokens.js
 *
 * Session state for admin auth (GF-032).
 *
 * - refresh_tokens: one row per issued refresh token, keyed by hash so a
 *   database leak never yields usable tokens. `family` ties every token in a
 *   rotation chain together, which is what makes reuse of a revoked token
 *   revocable across the whole chain.
 * - token_blacklist: access-token jtis revoked before their natural expiry.
 */
"use strict";

module.exports = {
  name: "019_admin_refresh_tokens",

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id         UUID PRIMARY KEY,
        admin_id   TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        family     TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        revoked    BOOLEAN NOT NULL DEFAULT false,
        revoked_at TIMESTAMPTZ
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_refresh_token_hash
      ON refresh_tokens (token_hash)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_refresh_family
      ON refresh_tokens (family)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS token_blacklist (
        jti        TEXT PRIMARY KEY,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  },

  async down(client) {
    await client.query("DROP TABLE IF EXISTS token_blacklist");
    await client.query("DROP INDEX IF EXISTS idx_refresh_family");
    await client.query("DROP INDEX IF EXISTS idx_refresh_token_hash");
    await client.query("DROP TABLE IF EXISTS refresh_tokens");
  },
};
