"use strict";

/**
 * src/db/migrations/018_secret_rotations.js
 *
 * Creates the secret_rotations audit table to track every automated or
 * manual secret rotation event. The CI/CD rotation workflow writes to
 * this table after every rotation cycle so operators have a full audit
 * trail of when secrets were rotated, by whom, which secrets were
 * affected, whether the health check passed, and whether a rollback
 * was triggered.
 */

module.exports = {
  name: "018_secret_rotations",

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS secret_rotations (
        id UUID PRIMARY KEY,
        workflow_run_id TEXT,
        triggered_by TEXT NOT NULL DEFAULT 'scheduled',
        secrets_rotated TEXT[] NOT NULL DEFAULT '{}',
        old_secret_hashes JSONB NOT NULL DEFAULT '{}',
        new_secret_hashes JSONB NOT NULL DEFAULT '{}',
        eso_force_sync_triggered_at TIMESTAMPTZ,
        rolling_restart_started_at TIMESTAMPTZ,
        rolling_restart_completed_at TIMESTAMPTZ,
        health_check_passed BOOLEAN,
        health_check_details JSONB DEFAULT '{}',
        rollback_triggered BOOLEAN NOT NULL DEFAULT FALSE,
        rollback_reason TEXT,
        rollback_completed_at TIMESTAMPTZ,
        overall_status TEXT NOT NULL DEFAULT 'in_progress'
          CHECK (overall_status IN ('in_progress', 'completed', 'failed', 'rolled_back')),
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Index for listing rotations by start time (most recent first).
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_secret_rotations_started_at
        ON secret_rotations (started_at DESC)
    `);

    // Index for looking up rotations by workflow run id.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_secret_rotations_workflow_run
        ON secret_rotations (workflow_run_id)
    `);

    // Index for filtering by overall status.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_secret_rotations_status
        ON secret_rotations (overall_status)
    `);
  },

  async down(client) {
    await client.query("DROP TABLE IF EXISTS secret_rotations");
  },
};
