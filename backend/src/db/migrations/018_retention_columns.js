"use strict";

/**
 * Migration 018: Retention support columns.
 *
 * Adds the columns needed by the config-driven data-retention policies
 * (src/config/retentionPolicies.js + src/services/retentionWorker.js):
 *
 *   - project_subscriptions.anonymised_at
 *       Stamped when a subscription's PII (email, donor_address) is anonymized
 *       by the "project-subscriptions-anonymize" policy. Makes the anonymize
 *       step idempotent (the policy's WHERE clause excludes rows already
 *       stamped) and auditable.
 *
 *   - device_tokens.retention_expires_at
 *   - webhook_deliveries.retention_expires_at
 *   - webhook_dlq.retention_expires_at
 *       Explicit per-row expiry markers that operators / backfills can use to
 *       reason about when a row becomes eligible for deletion. The default
 *       delete policies compute eligibility from created_at, but these columns
 *       are populated by the same time window on write-time tooling and give
 *       DBAs a direct, index-friendly predicate.
 *
 * All additions are ADD COLUMN IF NOT EXISTS so the migration is idempotent.
 * No existing columns or tables are modified and no NOT NULL constraints are
 * introduced (these are nullable markers), preserving backward compatibility.
 */

module.exports = {
  name: "018_retention_columns",

  async up(client) {
    await client.query(`
      ALTER TABLE project_subscriptions
      ADD COLUMN IF NOT EXISTS anonymised_at TIMESTAMPTZ
    `);

    await client.query(`
      ALTER TABLE device_tokens
      ADD COLUMN IF NOT EXISTS retention_expires_at TIMESTAMPTZ
    `);

    await client.query(`
      ALTER TABLE webhook_deliveries
      ADD COLUMN IF NOT EXISTS retention_expires_at TIMESTAMPTZ
    `);

    await client.query(`
      ALTER TABLE webhook_dlq
      ADD COLUMN IF NOT EXISTS retention_expires_at TIMESTAMPTZ
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_project_subscriptions_anonymised
      ON project_subscriptions (anonymised_at)
      WHERE anonymised_at IS NOT NULL
    `);
  },

  async down(client) {
    await client.query(
      "DROP INDEX IF EXISTS idx_project_subscriptions_anonymised",
    );
    await client.query(
      "ALTER TABLE webhook_dlq DROP COLUMN IF EXISTS retention_expires_at",
    );
    await client.query(
      "ALTER TABLE webhook_deliveries DROP COLUMN IF EXISTS retention_expires_at",
    );
    await client.query(
      "ALTER TABLE device_tokens DROP COLUMN IF EXISTS retention_expires_at",
    );
    await client.query(
      "ALTER TABLE project_subscriptions DROP COLUMN IF EXISTS anonymised_at",
    );
  },
};
