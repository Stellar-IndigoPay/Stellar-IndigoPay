"use strict";

/**
 * 012_project_geocoding
 *
 * Adds latitude/longitude columns to projects so location strings can be
 * resolved to coordinates once (at registration time) instead of being
 * re-geocoded client-side on every page load. A composite index supports
 * the Haversine-based GET /api/projects/nearby proximity search.
 */
module.exports = {
  name: "012_project_geocoding",

  async up(client) {
    await client.query(
      "ALTER TABLE projects ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION",
    );
    await client.query(
      "ALTER TABLE projects ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION",
    );
    await client.query(
      "CREATE INDEX IF NOT EXISTS idx_projects_location ON projects (latitude, longitude)",
    );
  },

  async down(client) {
    await client.query("DROP INDEX IF EXISTS idx_projects_location");
    await client.query(
      "ALTER TABLE projects DROP COLUMN IF EXISTS longitude",
    );
    await client.query(
      "ALTER TABLE projects DROP COLUMN IF EXISTS latitude",
    );
  },
};
