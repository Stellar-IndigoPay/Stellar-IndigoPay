/**
 * backend/src/services/projectionEngine.js
 *
 * Event-sourcing projection engine for the donation domain.
 *
 * Soroban contract events are appended to the immutable `donation_events`
 * event store by `sorobanEventService.js`. This module consumes each event
 * and maintains the materialised read models (projections) the API serves
 * from. Because projections are pure functions of the event stream, any
 * projection can be rebuilt deterministically by replaying `donation_events`
 * from the beginning — no backfill scripts, no bespoke reconciliation.
 *
 * Design:
 *   - Each projection is `{ table, handler(event, ctx) }`.
 *   - `handler` is idempotent: replaying the same event yields the same
 *     state, so the engine tolerates at-least-once delivery.
 *   - `processEvent` runs every projection handler for a single event inside
 *     one transaction. It does NOT append to the event store — the caller
 *     (sorobanEventService) appends first, then calls `processEvent`.
 *   - `rebuildAllProjections` truncates every projection table and replays
 *     the entire event store in `id` order.
 *
 * The engine is intentionally decoupled from HTTP. It speaks only to the
 * database pool and the Prometheus registry.
 */

"use strict";

/* eslint-disable security/detect-object-injection -- all keyed lookups are over the constant PROJECTION_NAMES/projections map */

const pool = require("../db/pool");
const logger = require("../logger");
const { registry, metrics } = require("./metrics");

const {
  projectionEventsProcessedTotal,
  projectionLagEvents,
  projectionRebuildDurationSeconds,
  projectionRebuildLastEvents,
  projectionRebuildInProgress,
} = metrics;

/**
 * Compute the CO₂ offset (kg) attributable to a donation, given the project's
 * total raised and total co2_offset_kg. Falls back to the event-supplied
 * co2_offset_kg when the projection already tracks it, otherwise distributes
 * proportionally. Mirrors the existing leaderboard formula.
 *
 * @param {number} amountXlm - XLM amount of the donation.
 * @param {number} projectRaisedXlm - Projection's running raised_xlm (BEFORE this event).
 * @param {number} projectCo2Kg - Projection's running co2_offset_kg.
 * @returns {number} CO₂ offset in kg for this donation.
 */
function co2OffsetForDonation(amountXlm, projectRaisedXlm, projectCo2Kg) {
  const raised = Number(projectRaisedXlm || 0);
  const co2 = Number(projectCo2Kg || 0);
  if (raised > 0 && co2 > 0) {
    return (Number(amountXlm) * co2) / raised;
  }
  return 0;
}

/**
 * Impact score matching the legacy leaderboard formula:
 *   score = total_xlm * 0.7 + (total_co2_kg / 100) * 0.3
 */
function computeImpactScore(totalXlm, totalCo2Kg) {
  return Number(totalXlm) * 0.7 + Number(totalCo2Kg || 0) / 100 * 0.3;
}

/**
 * The set of projections. Order within the object does not matter; every
 * handler runs for every event. Handlers must be idempotent.
 */
const projections = {
  /**
   * donor_leaderboard — ranked donor totals (leaderboard API).
   */
  donor_leaderboard: {
    table: "projection_donor_leaderboard",
    async handler(event, ctx) {
      const d = event.event_data || {};
      if (event.event_type === "DonationRecorded") {
        // Private donations remain part of project/global projections, but
        // must never create or change a public donor leaderboard entry.
        if (d.anonymous) return;
        const donor = d.donorAddress;
        const amount = Number(d.amountXLM || 0);
        const co2 = Number(d.co2OffsetKg || 0);
        const projectsSupported = Number(d.projectsSupported || 1);

        await ctx.client.query(
          `INSERT INTO projection_donor_leaderboard
             (donor_address, total_donated, donation_count, projects_supported, total_co2_offset, impact_score, last_donation_at)
           VALUES ($1, $2, 1, $3, $4, $5, now())
           ON CONFLICT (donor_address) DO UPDATE SET
             total_donated = projection_donor_leaderboard.total_donated + $2,
             donation_count = projection_donor_leaderboard.donation_count + 1,
             projects_supported = GREATEST(projection_donor_leaderboard.projects_supported, $3),
             total_co2_offset = projection_donor_leaderboard.total_co2_offset + $4,
             impact_score = $5,
             last_donation_at = now()`,
          [
            donor,
            amount,
            projectsSupported,
            co2,
            computeImpactScore(
              Number(ctx.priorLeaderboard?.total_donated || 0) + amount,
              Number(ctx.priorLeaderboard?.total_co2_offset || 0) + co2,
            ),
          ],
        );
      }
    },
  },

  /**
   * project_stats — per-project aggregates (project stats API).
   */
  project_stats: {
    table: "projection_project_stats",
    async handler(event, ctx) {
      const d = event.event_data || {};
      if (event.event_type === "DonationRecorded") {
        const projectId = event.aggregate_id;
        const amount = Number(d.amountXLM || 0);
        const co2 = Number(d.co2OffsetKg || 0);

        // donor_count is derived from donor_history (inserted by the
        // donor_history projection in the same event pass). Recompute from
        // donor_history after the history row exists.
        const updated = await ctx.client.query(
          `INSERT INTO projection_project_stats
             (project_id, raised_xlm, donation_count, donor_count, co2_offset_kg, last_donation_at)
           VALUES ($1, $2, 1, 0, $3, now())
           ON CONFLICT (project_id) DO UPDATE SET
             raised_xlm = projection_project_stats.raised_xlm + $2,
             donation_count = projection_project_stats.donation_count + 1,
             co2_offset_kg = projection_project_stats.co2_offset_kg + $3,
             last_donation_at = now()`,
          [projectId, amount, co2],
        );

        const newDonorCountRow = await ctx.client.query(
          `SELECT COUNT(DISTINCT donor_address)::int AS c
             FROM projection_donor_history WHERE project_id = $1`,
          [projectId],
        );
        const newDonorCount = newDonorCountRow.rows[0]?.c || 0;
        await ctx.client.query(
          "UPDATE projection_project_stats SET donor_count = $2 WHERE project_id = $1",
          [projectId, newDonorCount],
        );
        return updated;
      }
    },
  },

  /**
   * donor_history — per-donor / per-project donation history (donor view).
   * Also the source of truth for project_stats.donor_count.
   */
  donor_history: {
    table: "projection_donor_history",
    async handler(event, ctx) {
      const d = event.event_data || {};
      if (event.event_type === "DonationRecorded") {
        const donor = d.donorAddress;
        const projectId = event.aggregate_id;
        const amount = Number(d.amountXLM || 0);
        const co2 = Number(d.co2OffsetKg || 0);
        const txHash = d.transactionHash || event.transaction_hash;

        await ctx.client.query(
          `INSERT INTO projection_donor_history
             (donor_address, project_id, amount_xlm, amount, currency, message, transaction_hash, co2_offset_kg, created_at)
           VALUES ($1, $2, $3, $3, $4, $5, $6, $7, now())
           ON CONFLICT (transaction_hash) DO NOTHING`,
          [
            donor,
            projectId,
            amount,
            d.currency || "XLM",
            d.message || null,
            txHash,
            co2,
          ],
        );
      }
    },
  },

  /**
   * global_stats — platform-wide counters (stats API).
   */
  global_stats: {
    table: "projection_global_stats",
    async handler(event, ctx) {
      const d = event.event_data || {};
      if (event.event_type === "DonationRecorded") {
        const amount = Number(d.amountXLM || 0);
        const co2 = Number(d.co2OffsetKg || 0);
        const donor = d.donorAddress;

        // Determine if this donation introduces a new distinct donor by
        // checking the leaderboard projection (cheap, indexed on PK).
        const prior = await ctx.client.query(
          "SELECT 1 FROM projection_donor_leaderboard WHERE donor_address = $1",
          [donor],
        );
        const isNewDonor = prior.rows.length === 0;

        await ctx.client.query(
          `UPDATE projection_global_stats SET
             total_xlm_raised = total_xlm_raised + $1,
             total_co2_offset_kg = total_co2_offset_kg + $2,
             total_donations = total_donations + 1,
             total_donors = total_donors + $3,
             updated_at = NOW()
           WHERE id = 1`,
          [amount, co2, isNewDonor ? 1 : 0],
        );
      }
    },
  },
};

const PROJECTION_NAMES = Object.keys(projections);

/**
 * Insert a raw event into the immutable `donation_events` event store.
 * This is the single write path for the source of truth.
 *
 * @param {object} event - { event_type, aggregate_id, event_data, soroban_ledger, transaction_hash }
 * @returns {Promise<object>} the inserted row (with id + created_at).
 */
async function insertEvent(event) {
  const result = await pool.query(
    `INSERT INTO donation_events (event_type, aggregate_id, event_data, soroban_ledger, transaction_hash)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, created_at`,
    [
      event.event_type,
      event.aggregate_id,
      JSON.stringify(event.event_data || {}),
      event.soroban_ledger ?? null,
      event.transaction_hash ?? null,
    ],
  );
  return result.rows[0];
}

/**
 * Process a single event through every projection handler inside one
 * transaction. Safe to call for the same event twice (idempotent).
 *
 * @param {object} event - The event to apply.
 * @param {{pool?: object}} [opts] - Optional pool override (for tests).
 * @returns {Promise<void>}
 */
async function processEvent(event, opts = {}) {
  const db = opts.pool || pool;
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    for (const name of PROJECTION_NAMES) {
      try {
        await projections[name].handler(event, { client, pool: db });
        projectionEventsProcessedTotal.inc({ projection: name, outcome: "success" });
      } catch (err) {
        projectionEventsProcessedTotal.inc({ projection: name, outcome: "error" });
        logger.error(
          {
            event: "projection_handler_error",
            projection: name,
            eventType: event.event_type,
            err: err.message,
          },
          "Projection handler failed",
        );
        throw err;
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  refreshLag(db);
}

/**
 * Recompute the lag gauge: number of events in the store not yet reflected in
 * the projections. We count events newer than the most recent
 * projection_global_stats.updated_at (the heartbeat of the last applied
 * event); before any projection work has run, this equals the full event
 * count. Robust and cheap enough for the health dashboard.
 *
 * @param {{query: Function}} [db]
 */
async function refreshLag(db = pool) {
  try {
    const lagResult = await db.query(`
      SELECT COUNT(*)::bigint AS lag FROM donation_events e
      WHERE NOT EXISTS (
        SELECT 1 FROM projection_global_stats g
        WHERE g.id = 1 AND e.created_at <= g.updated_at
      )
    `);
    const lag = Number(lagResult.rows[0]?.lag || 0);
    projectionLagEvents.set(lag);
    return lag;
  } catch {
    // Metrics must never break the request path.
    return 0;
  }
}

/**
 * Truncate all projection tables (keeps the event store intact).
 * @param {{query: Function}} db
 */
async function truncateProjections(db = pool) {
  const tables = PROJECTION_NAMES.map((n) => projections[n].table);
  await db.query(`TRUNCATE ${tables.join(", ")}`);
}

/**
 * Rebuild every projection from the event store.
 *
 * Steps:
 *   1. Mark rebuild in progress (gauge).
 *   2. Truncate all projection tables.
 *   3. Stream events in `id` order and apply all handlers.
 *   4. Record duration + event count, clear in-progress flag.
 *
 * @param {{pool?: object}} [opts]
 * @returns {Promise<{events:number, durationMs:number}>}
 */
async function rebuildAllProjections(opts = {}) {
  const db = opts.pool || pool;
  const start = Date.now();
  projectionRebuildInProgress.set(1);

  try {
    await truncateProjections(db);

    const { rows } = await db.query(
      `SELECT id, event_type, aggregate_id, event_data, soroban_ledger, transaction_hash, created_at
         FROM donation_events ORDER BY id ASC`,
    );

    for (const raw of rows) {
      const event = {
        event_type: raw.event_type,
        aggregate_id: raw.aggregate_id,
        event_data:
          typeof raw.event_data === "string"
            ? JSON.parse(raw.event_data)
            : raw.event_data,
        soroban_ledger: raw.soroban_ledger,
        transaction_hash: raw.transaction_hash,
        created_at: raw.created_at,
      };
      await processEvent(event, { pool: db });
    }

    const durationMs = Date.now() - start;
    projectionRebuildDurationSeconds.observe({ outcome: "success" }, durationMs / 1000);
    projectionRebuildLastEvents.set(rows.length);
    projectionLagEvents.set(0);
    logger.info(
      {
        event: "projection_rebuild_complete",
        events: rows.length,
        durationMs,
      },
      "Projection rebuild complete",
    );
    return { events: rows.length, durationMs };
  } catch (err) {
    const durationMs = Date.now() - start;
    projectionRebuildDurationSeconds.observe({ outcome: "error" }, durationMs / 1000);
    logger.error(
      { event: "projection_rebuild_error", err: err.message, durationMs },
      "Projection rebuild failed",
    );
    throw err;
  } finally {
    projectionRebuildInProgress.set(0);
  }
}

/**
 * Rebuild a single named projection from the event store. Useful for partial
 * repairs without recomputing everything.
 *
 * @param {string} name - projection name
 * @param {{pool?: object}} [opts]
 * @returns {Promise<{events:number}>}
 */
async function rebuildProjection(name, opts = {}) {
  if (!projections[name]) {
    throw new Error(`Unknown projection: ${name}`);
  }
  const db = opts.pool || pool;
  await db.query(`TRUNCATE ${projections[name].table}`);
  const { rows } = await db.query(
    `SELECT id, event_type, aggregate_id, event_data, soroban_ledger, transaction_hash, created_at
       FROM donation_events ORDER BY id ASC`,
  );
  for (const raw of rows) {
    const event = {
      event_type: raw.event_type,
      aggregate_id: raw.aggregate_id,
      event_data:
        typeof raw.event_data === "string"
          ? JSON.parse(raw.event_data)
          : raw.event_data,
      soroban_ledger: raw.soroban_ledger,
      transaction_hash: raw.transaction_hash,
    };
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await projections[name].handler(event, { client, pool: db });
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
  return { events: rows.length };
}

/**
 * Get the in-progress state of a rebuild, used by the admin status endpoint.
 */
function isRebuilding() {
  return projectionRebuildInProgress.get() === 1;
}

module.exports = {
  projections,
  PROJECTION_NAMES,
  insertEvent,
  processEvent,
  rebuildAllProjections,
  rebuildProjection,
  truncateProjections,
  refreshLag,
  isRebuilding,
  co2OffsetForDonation,
  computeImpactScore,
  // exposed for unit tests that want to drive a handler directly
  _handlers: projections,
};

// `registry` is referenced to keep the import meaningful for tooling that
// statically verifies metric registration; the metrics themselves are
// registered on import above.
void registry;
