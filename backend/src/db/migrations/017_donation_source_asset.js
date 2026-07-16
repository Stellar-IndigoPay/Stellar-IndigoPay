"use strict";

module.exports = {
  name: "017_donation_source_asset",

  async up(client) {
    // source_asset: the original asset the donor used (e.g. "yXLM:G…ISSUER…")
    await client.query(`
      ALTER TABLE donations
      ADD COLUMN IF NOT EXISTS source_asset TEXT
    `);

    // conversion_path: JSON array of asset codes/issuers used in the path payment
    await client.query(`
      ALTER TABLE donations
      ADD COLUMN IF NOT EXISTS conversion_path JSONB
    `);

    // converted_amount_xlm: the XLM-equivalent actually received by the project
    await client.query(`
      ALTER TABLE donations
      ADD COLUMN IF NOT EXISTS converted_amount_xlm NUMERIC(20, 7)
    `);

    // Index for analytics: quickly find donations made via a specific source asset
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_donations_source_asset
      ON donations (source_asset)
      WHERE source_asset IS NOT NULL
    `);
  },

  async down(client) {
    await client.query(
      "DROP INDEX IF EXISTS idx_donations_source_asset",
    );
    await client.query(
      "ALTER TABLE donations DROP COLUMN IF EXISTS converted_amount_xlm",
    );
    await client.query(
      "ALTER TABLE donations DROP COLUMN IF EXISTS conversion_path",
    );
    await client.query(
      "ALTER TABLE donations DROP COLUMN IF EXISTS source_asset",
    );
  },
};
