"use strict";

module.exports = {
  name: "031_indexer_state_crc",
  async up(client) {
    await client.query(`
      ALTER TABLE indexer_state 
      ADD COLUMN IF NOT EXISTS cursor_hash TEXT,
      ADD COLUMN IF NOT EXISTS value TEXT,
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW(),
      ALTER COLUMN last_processed_ledger DROP NOT NULL
    `);
  },
  async down(client) {
    await client.query(`
      ALTER TABLE indexer_state 
      DROP COLUMN IF EXISTS cursor_hash,
      DROP COLUMN IF EXISTS value,
      DROP COLUMN IF EXISTS updated_at,
      ALTER COLUMN last_processed_ledger SET NOT NULL
    `);
  }
};
