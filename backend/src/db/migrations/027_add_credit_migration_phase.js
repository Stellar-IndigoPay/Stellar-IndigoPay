"use strict";

/**
 * 027_add_credit_migration_phase
 *
 * Expand-contract example for a live schema rollout:
 * 1. Expand phase: add a nullable column with a safe default.
 * 2. Contract phase: remove the legacy column after the dual-write window.
 *
 * This example keeps the migration policy lint rules satisfied by keeping the
 * metadata explicit and avoiding unsafe rename/drop patterns in a single step.
 */
module.exports = {
  name: "027_add_credit_migration_phase",
  phase: "expand",
  dualWrite: true,

  async up(client) {
    await client.query(`
      ALTER TABLE credits
      ADD COLUMN IF NOT EXISTS legacy_status TEXT DEFAULT 'pending'
    `);
  },

  async down(client) {
    await client.query(`
      ALTER TABLE credits
      DROP COLUMN IF EXISTS legacy_status
    `);
  },
};
