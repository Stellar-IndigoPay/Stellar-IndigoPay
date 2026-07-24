"use strict";

/**
 * 023_co2_verification_runs
 *
 * Creates the co2_verification_runs table that records every automated
 * CO₂ offset-rate verification run performed by services/co2Verifier.js.
 *
 * Each row captures the project's claimed rate, the computed confidence
 * band, the source(s) used for reference data (including satellite-derived
 * biomass estimates when available), and whether the rate fell within the
 * plausible range.
 *
 * A compound index on (project_id, verified_at DESC) supports the admin
 * dashboard's "latest verification per project" query and the project
 * detail page's verification history panel.
 */
module.exports = {
  name: "023_co2_verification_runs",

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS co2_verification_runs (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        claimed_rate    INTEGER NOT NULL,
        confidence_lower INTEGER NOT NULL,
        confidence_upper INTEGER NOT NULL,
        is_plausible    BOOLEAN NOT NULL,
        reference_source VARCHAR(255) NOT NULL,
        satellite_source VARCHAR(255),
        flag_reason     TEXT,
        verified_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_co2_verification_project
        ON co2_verification_runs (project_id, verified_at DESC)
    `);
  },

  async down(client) {
    await client.query(
      "DROP INDEX IF EXISTS idx_co2_verification_project"
    );
    await client.query("DROP TABLE IF EXISTS co2_verification_runs");
  },
};
