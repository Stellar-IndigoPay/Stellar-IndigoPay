/**
 * 032_admin_password_auth.js
 *
 * Password-based admin authentication with MFA (issue #1123 Part B).
 *
 * Before this migration the only admin credential was a pre-shared API key
 * (X-Admin-Key) or the ADMIN_USERNAME/ADMIN_PASSWORD env pair. This table
 * gives operators a real identity — email + bcrypt password — that the
 * session machinery (refresh_tokens) can hang off, with an optional TOTP
 * second factor.
 *
 *   - email:         unique login identifier, stored lowercase.
 *   - password_hash: bcrypt hash (bcryptjs, $2b$ prefix).
 *   - mfa_secret:    base32 TOTP secret. Set by /auth/mfa/setup and only
 *                    enforced once /auth/mfa/verify has confirmed the code,
 *                    so a half-finished setup never locks anyone out.
 *   - mfa_enabled:   true only after the first TOTP code is verified.
 *
 * The existing X-Admin-Key path and the env-based login remain untouched;
 * this table is an additional credential source, not a replacement.
 */
"use strict";

module.exports = {
  name: "032_admin_password_auth",

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS admins (
        id            UUID PRIMARY KEY,
        email         TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        mfa_secret    TEXT,
        mfa_enabled   BOOLEAN NOT NULL DEFAULT FALSE,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  },

  async down(client) {
    await client.query("DROP TABLE IF EXISTS admins");
  },
};
