"use strict";

module.exports = {
  name: "020_alter_idempotency_keys",

  async up(client) {
    await client.query(`
      ALTER TABLE idempotency_keys 
      ADD COLUMN IF NOT EXISTS request_body_hash TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours');
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_keys (expires_at);
    `);
  },

  async down(client) {
    await client.query(`
      DROP INDEX IF EXISTS idx_idempotency_expires;
    `);
    
    await client.query(`
      ALTER TABLE idempotency_keys
      DROP COLUMN IF EXISTS request_body_hash,
      DROP COLUMN IF EXISTS expires_at;
    `);
  },
};
