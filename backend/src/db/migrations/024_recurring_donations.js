"use strict";

/**
 * 024_recurring_donations
 *
 * Creates the recurring_donations table to store on-chain recurring schedules
 * and their metadata. This is used by the keeper service to determine when
 * a schedule is due for execution.
 */
module.exports = {
  name: "024_recurring_donations",

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS recurring_donations (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        donor_address     VARCHAR(56) NOT NULL,
        recurring_id      INTEGER NOT NULL,
        project_id        UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        amount            NUMERIC(20, 7) NOT NULL,
        currency          VARCHAR(10) NOT NULL DEFAULT 'XLM',
        interval_seconds  INTEGER NOT NULL,
        next_execution_at TIMESTAMPTZ NOT NULL,
        keeper_incentive  NUMERIC(20, 7) NOT NULL DEFAULT 0.5,
        active            BOOLEAN NOT NULL DEFAULT TRUE,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_donor_recurring UNIQUE (donor_address, recurring_id)
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_recurring_donor_active
        ON recurring_donations (donor_address, active)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_recurring_next_execution
        ON recurring_donations (next_execution_at)
        WHERE active = TRUE
    `);
  },

  async down(client) {
    await client.query("DROP INDEX IF EXISTS idx_recurring_next_execution");
    await client.query("DROP INDEX IF EXISTS idx_recurring_donor_active");
    await client.query("DROP TABLE IF EXISTS recurring_donations");
  },
};
