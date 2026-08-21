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
    // This is a documentation example: `credits` is not a real table in this
    // codebase, so a fresh database bootstrapped purely from migrations has
    // no such relation. Skip when the table is absent so the example can
    // never break a replica boot (issue #640).
    const { rows } = await client.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'credits'`,
    );
    if (rows.length === 0) return;

    await client.query(`
      DO $$
      BEGIN
        IF to_regclass('public.credits') IS NOT NULL THEN
          ALTER TABLE credits
          ADD COLUMN IF NOT EXISTS legacy_status TEXT DEFAULT 'pending';
        END IF;
      END
      $$;
    `);
  },

  async down(client) {
    const { rows } = await client.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'credits'`,
    );
    if (rows.length === 0) return;

    await client.query(`
      DO $$
      BEGIN
        IF to_regclass('public.credits') IS NOT NULL THEN
          ALTER TABLE credits
          DROP COLUMN IF EXISTS legacy_status;
        END IF;
      END
      $$;
    `);
  },
};
