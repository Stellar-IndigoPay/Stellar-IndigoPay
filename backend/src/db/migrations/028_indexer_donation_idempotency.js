"use strict";

/**
 * 028_indexer_donation_idempotency
 *
 * Horizon can redeliver an operation after a cursor rollback, and a single
 * Stellar transaction can contain more than one payment operation. The old
 * transaction-hash-only constraint treated those cases the same. Keep
 * transaction-hash uniqueness for non-indexer writers while giving Horizon
 * operations a stable composite identity.
 */
module.exports = {
  name: "028_indexer_donation_idempotency",
  phase: "expand",

  async up(client) {
    await client.query(`
      ALTER TABLE donations
      ADD COLUMN IF NOT EXISTS indexer_operation_id TEXT
    `);

    await client.query(
      "ALTER TABLE donations DROP CONSTRAINT IF EXISTS donations_transaction_hash_key",
    );

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_donations_tx_operation_id
      ON donations (transaction_hash, indexer_operation_id)
      WHERE indexer_operation_id IS NOT NULL
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_donations_tx_without_operation_id
      ON donations (transaction_hash)
      WHERE indexer_operation_id IS NULL
    `);
  },

  async down(client) {
    await client.query(
      "DROP INDEX IF EXISTS uq_donations_tx_operation_id",
    );
    await client.query(
      "DROP INDEX IF EXISTS uq_donations_tx_without_operation_id",
    );
    await client.query(
      "ALTER TABLE donations DROP COLUMN IF EXISTS indexer_operation_id",
    );
    await client.query(
      "ALTER TABLE donations DROP CONSTRAINT IF EXISTS donations_transaction_hash_key",
    );
    await client.query(
      "ALTER TABLE donations ADD CONSTRAINT donations_transaction_hash_key UNIQUE (transaction_hash)",
    );
  },
};
