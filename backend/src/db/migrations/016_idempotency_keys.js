"use strict";

module.exports = {
  name: "016_idempotency_keys",

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS idempotency_keys (
        key            TEXT PRIMARY KEY,
        response_status INTEGER NOT NULL,
        response_body  JSONB NOT NULL,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Index to support efficient cleanup of expired keys
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created_at
        ON idempotency_keys (created_at)
    `);
  },

  async down(client) {
    await client.query("DROP TABLE IF EXISTS idempotency_keys");
  },
};
