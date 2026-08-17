"use strict";

/**
 * 030_usdc_rate_snapshot
 *
 * Snapshot the USDC→XLM conversion rate (and its source) on each donation at
 * ingestion time (closes #683). Historical donations previously used the
 * mutable, in-process `usdcToXlmRate`, so a later rate correction or a
 * backfill/replay could silently re-value already-recorded donations.
 *
 *   - usdc_rate_at_donation — the USDC→XLM rate actually applied when the
 *     donation was recorded. NULL for native XLM donations.
 *   - usdc_rate_source     — where the rate came from ("env" for
 *     `USDC_TO_XLM_RATE`, "default" for the built-in 8.0 fallback).
 */
module.exports = {
  name: "030_usdc_rate_snapshot",

  async up(client) {
    await client.query(`
      ALTER TABLE donations
        ADD COLUMN IF NOT EXISTS usdc_rate_at_donation NUMERIC(20, 7),
        ADD COLUMN IF NOT EXISTS usdc_rate_source TEXT
    `);
  },

  async down(client) {
    await client.query(`
      ALTER TABLE donations
        DROP COLUMN IF EXISTS usdc_rate_source,
        DROP COLUMN IF EXISTS usdc_rate_at_donation
    `);
  },
};
