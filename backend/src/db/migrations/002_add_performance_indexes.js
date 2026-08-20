"use strict";

/**
 * 002_add_performance_indexes
 *
 * NOTE: indexes are created with plain (non-CONCURRENTLY) statements because
 * the migration runner applies every migration inside a transaction block,
 * and `CREATE INDEX CONCURRENTLY` cannot run inside a transaction. Concurrent
 * application across replicas is already prevented by the migration advisory
 * lock (issue #640), so the lock-free guarantee CONCURRENTLY exists for is
 * provided by the runner itself.
 */
module.exports = {
  name: "002_add_performance_indexes",

  async up(client) {
    await client.query(
      "CREATE INDEX IF NOT EXISTS idx_donations_project_created ON donations(project_id, created_at DESC)",
    );
    await client.query(
      "CREATE INDEX IF NOT EXISTS idx_profiles_donated ON profiles(total_donated_xlm DESC)",
    );
    await client.query(
      "CREATE INDEX IF NOT EXISTS idx_projects_status_donor ON projects(status, donor_count DESC)",
    );
  },

  async down(client) {
    await client.query(
      "DROP INDEX IF EXISTS idx_projects_status_donor",
    );
    await client.query(
      "DROP INDEX IF EXISTS idx_profiles_donated",
    );
    await client.query(
      "DROP INDEX IF EXISTS idx_donations_project_created",
    );
  },
};
