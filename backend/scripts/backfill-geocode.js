#!/usr/bin/env node

/**
 * backfill-geocode.js — geocode existing projects that predate the
 * lat/lng columns added in migration 012_project_geocoding.
 *
 * Usage:
 *   node backend/scripts/backfill-geocode.js
 *
 * Processes every project with a NULL latitude, resolving `location`
 * through services/geocoder.js (Nominatim, rate-limited to 1 req/sec,
 * 30-day cache). Projects that fail to geocode are left NULL and logged
 * so they can be retried on a later run.
 */

"use strict";

const pool = require("../src/db/pool");
const { geocode } = require("../src/services/geocoder");

async function backfill() {
  const { rows } = await pool.query(
    "SELECT id, location FROM projects WHERE latitude IS NULL ORDER BY created_at ASC",
  );

  console.log(`[backfill-geocode] ${rows.length} project(s) missing coordinates`);

  let geocoded = 0;
  let failed = 0;

  for (const row of rows) {
    const coords = await geocode(row.location);
    if (coords) {
      await pool.query(
        "UPDATE projects SET latitude = $1, longitude = $2 WHERE id = $3",
        [coords.latitude, coords.longitude, row.id],
      );
      geocoded++;
      console.log(`[backfill-geocode] geocoded ${row.id} (${row.location}) -> ${coords.latitude}, ${coords.longitude}`);
    } else {
      failed++;
      console.warn(`[backfill-geocode] could not geocode ${row.id} (${row.location})`);
    }
  }

  console.log(`[backfill-geocode] done: ${geocoded} geocoded, ${failed} failed`);
}

if (require.main === module) {
  backfill()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[backfill-geocode] failed:", err.message);
      process.exit(1);
    });
}

module.exports = { backfill };
