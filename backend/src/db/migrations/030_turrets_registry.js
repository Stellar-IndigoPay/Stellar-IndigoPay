"use strict";

module.exports = {
  name: "030_turrets_registry",

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS turrets (
        id UUID PRIMARY KEY,
        name TEXT NOT NULL,
        scope TEXT NOT NULL,
        api_key_hash TEXT NOT NULL,
        prev_api_key_hash TEXT,
        prev_api_key_expires_at TIMESTAMPTZ,
        status TEXT NOT NULL DEFAULT 'active',
        key_version INTEGER NOT NULL DEFAULT 1,
        last_heartbeat TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_turrets_api_key_hash ON turrets (api_key_hash)
    `);
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_turrets_prev_api_key_hash ON turrets (prev_api_key_hash) WHERE prev_api_key_hash IS NOT NULL
    `);
  },

  async down(client) {
    await client.query("DROP TABLE IF EXISTS turrets");
  },
};
