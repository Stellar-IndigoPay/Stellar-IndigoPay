"use strict";

/**
 * Migration: 005_attestations
 *
 * Adds the `attestations` table that the backend keeps in lockstep with the
 * Soroban `attestation-contract` (cross-chain donation attestation bridge,
 * issue #125). The schema mirrors the on-chain fields exactly so that the
 * backend can fall back to DB reads when the RPC is unreachable, and the
 * indexer can write transactions with full exchange coverage.
 *
 * Replay protection:
 *   UNIQUE (source_chain, source_tx_hash) — a duplicate source tx can never
 *   be recorded twice in the DB even before the on-chain guard fires. This
 *   gives the indexer a fast path to dedupe without round-tripping every op
 *   to Soroban.
 *
 * Foreign key:
 *   project_id references projects(id) ON DELETE SET NULL so that
 *   removing a project (e.g. after admin takedown) doesn't cascade-delete
 *   the historical donation trail.
 */
module.exports = {
  name: "005_attestations",

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS attestations (
        id UUID PRIMARY KEY,
        -- Mirrors the on-chain monotonic counter set by the relayer.
        -- Separate from \`id\` (UUID) so multiple backend replicas can
        -- converge on the same on-chain id without conflicting inserts.
        on_chain_id BIGINT NOT NULL UNIQUE,
        source_chain TEXT NOT NULL,
        source_tx_hash TEXT NOT NULL,
        donor_address TEXT NOT NULL,
        project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
        amount_usd NUMERIC(20, 6) NOT NULL CHECK (amount_usd > 0),
        amount_xlm NUMERIC(20, 7) NOT NULL CHECK (amount_xlm > 0),
        message_hash BIGINT NOT NULL DEFAULT 0,
        -- Mirrors AttestationStatus on-chain: pending | verified | revoked.
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        verified_at TIMESTAMPTZ,
        -- The relayer Stellar address that submitted \`record_attestation\`.
        recorded_by TEXT,
        CONSTRAINT attestations_status_check
          CHECK (status IN ('pending','verified','revoked')),
        CONSTRAINT attestations_source_unique
          UNIQUE (source_chain, source_tx_hash)
      )
    `);

    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_attestations_donor
         ON attestations (donor_address, created_at DESC)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_attestations_project
         ON attestations (project_id, created_at DESC)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_attestations_status
         ON attestations (status, created_at DESC)`,
    );

    // Surface verify-projection: history view that powers the public
    // /api/attestations/by-donor/:addr endpoint without exposing internal
    // columns like `recorded_by` outside the admin scope.
    await client.query(`
      CREATE OR REPLACE VIEW attestations_public AS
      SELECT
        id,
        on_chain_id,
        source_chain,
        source_tx_hash,
        donor_address,
        project_id,
        amount_usd,
        amount_xlm,
        status,
        message_hash,
        created_at,
        verified_at
      FROM attestations
    `);
  },

  async down(client) {
    await client.query("DROP VIEW IF EXISTS attestations_public");
    await client.query("DROP TABLE IF EXISTS attestations");
  },
};
