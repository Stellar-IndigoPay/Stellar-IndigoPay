"use strict";

/**
 * 018_co2_verification
 *
 * Adds automated CO₂ offset-rate verification state to projects.
 * co2_per_xlm is self-reported by applicants, so services/co2Verifier.js
 * compares it against per-category industry benchmarks when a
 * verification request is approved and records the verdict here:
 *
 *   pending  — default; verification has not run for this project yet
 *   verified — rate within 3× the category benchmark
 *   review   — rate 3–10× the benchmark; above typical range
 *   flagged  — rate >10× the benchmark; requires admin resolution
 *   rejected — an admin rejected the claimed rate
 *
 * co2_verification_notes stores the human-readable reason (either from
 * the verifier or an admin's resolution note). A partial index supports
 * the admin dashboard's "outstanding flags" listing.
 */
module.exports = {
  name: "018_co2_verification",

  async up(client) {
    await client.query(
      `ALTER TABLE projects
         ADD COLUMN IF NOT EXISTS co2_verification_status TEXT NOT NULL DEFAULT 'pending'`,
    );
    await client.query(
      "ALTER TABLE projects ADD COLUMN IF NOT EXISTS co2_verification_notes TEXT",
    );
    await client.query(
      "ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_co2_verification_status_check",
    );
    await client.query(
      `ALTER TABLE projects
         ADD CONSTRAINT projects_co2_verification_status_check
         CHECK (co2_verification_status IN ('pending', 'verified', 'review', 'flagged', 'rejected'))`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_projects_co2_verification_status
         ON projects (co2_verification_status)
         WHERE co2_verification_status IN ('review', 'flagged')`,
    );
  },

  async down(client) {
    await client.query(
      "DROP INDEX IF EXISTS idx_projects_co2_verification_status",
    );
    await client.query(
      "ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_co2_verification_status_check",
    );
    await client.query(
      "ALTER TABLE projects DROP COLUMN IF EXISTS co2_verification_notes",
    );
    await client.query(
      "ALTER TABLE projects DROP COLUMN IF EXISTS co2_verification_status",
    );
  },
};
