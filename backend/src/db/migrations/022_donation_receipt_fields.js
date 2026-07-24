"use strict";

/** Fields and immutable proof metadata for tax-deductible donation receipts. */
module.exports = {
  name: "022_donation_receipt_fields",

  async up(client) {
    await client.query(`
      ALTER TABLE donations
        ADD COLUMN IF NOT EXISTS anonymous BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS fiat_amount_usd NUMERIC(14, 2),
        ADD COLUMN IF NOT EXISTS fiat_rate_at_donation NUMERIC(20, 7),
        ADD COLUMN IF NOT EXISTS receipt_generated_at TIMESTAMPTZ;

      CREATE TABLE IF NOT EXISTS donation_receipts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        donation_id UUID NOT NULL UNIQUE REFERENCES donations(id) ON DELETE CASCADE,
        receipt_hash VARCHAR(64) NOT NULL,
        signature VARCHAR(128) NOT NULL,
        pdf BYTEA NOT NULL,
        generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  },

  async down(client) {
    await client.query("DROP TABLE IF EXISTS donation_receipts");
    await client.query(`
      ALTER TABLE donations
        DROP COLUMN IF EXISTS anonymous,
        DROP COLUMN IF EXISTS receipt_generated_at,
        DROP COLUMN IF EXISTS fiat_rate_at_donation,
        DROP COLUMN IF EXISTS fiat_amount_usd;
    `);
  },
};
