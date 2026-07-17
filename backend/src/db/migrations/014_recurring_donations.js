"use strict";

/**
 * 014_recurring_donations
 *
 * Adds a `recurring_donations` table synced from on-chain Soroban contract
 * subscription state. The backend cron (recurringDonationService.js) polls
 * this table for due subscriptions and submits Stellar transactions.
 */
module.exports = {
  name: "014_recurring_donations",

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS recurring_donations (
        id                SERIAL PRIMARY KEY,
        subscription_id   INTEGER NOT NULL,
        donor_address     VARCHAR(56) NOT NULL,
        project_id        VARCHAR(64) NOT NULL,
        amount_stroops    NUMERIC(39,0) NOT NULL,
        interval_ledgers  INTEGER NOT NULL,
        next_payment_ledger INTEGER NOT NULL,
        remaining_payments INTEGER NOT NULL,
        active            BOOLEAN NOT NULL DEFAULT TRUE,
        created_at_ledger INTEGER NOT NULL,
        last_paid_at      TIMESTAMPTZ,
        next_payment_due_at TIMESTAMPTZ,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(subscription_id)
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_recurring_donations_donor
        ON recurring_donations(donor_address)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_recurring_donations_due
        ON recurring_donations(next_payment_ledger, active)
        WHERE active = TRUE
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_recurring_donations_project
        ON recurring_donations(project_id)
    `);
  },

  async down(client) {
    await client.query("DROP TABLE IF EXISTS recurring_donations");
  },
};
