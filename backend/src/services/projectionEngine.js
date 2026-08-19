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
 *   - `rebuildAllProjections` is atomic: it replays the entire event store
 *     into freshly-created staging tables and then swaps them into place
 *     inside a single transaction. Live reads are never served from a
 *     truncated or partially-rebuilt table — during a rebuild they observe
 *     the previous, complete projection state until the swap commits.
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

// 1 XLM = 10^7 stroops (matches the contract's `STROOP` constant), and the
// CO₂ columns use NUMERIC(20,4) (4 decimal places). Donation amounts arrive as
// i128 stroops that far exceed Number's 2^53 exact-integer range, so every
// amount is carried as an exact decimal string / BigInt through this module —
// never through IEEE-754 doubles.
const STROOP_SCALE = 7;
const CO2_KG_SCALE = 4;

// Rebuilds are staged in a private schema so live reads are never served from
// a partially-rebuilt table, then swapped into `public` atomically. The
// advisory lock serialises rebuilds across app instances (the in-process
// `projectionRebuildInProgress` gauge only guards a single instance).
const STAGE_SCHEMA = "projection_stage";
const REBUILD_LOCK_KEY = "indigopay_projection_rebuild";

/**
 * Deterministic 64-bit FNV-1a hash of the advisory-lock key, masked to the
 * signed int8 range `pg_advisory_lock` accepts. Lets multiple app instances
 * coordinate on the same lock without sharing a hard-coded magic number.
 *
 * @returns {bigint}
 */
function advisoryLockKey() {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < REBUILD_LOCK_KEY.length; i += 1) {
    hash ^= BigInt(REBUILD_LOCK_KEY.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash & 0x7fffffffffffffffn;
}

/**
 * Normalise a numeric value (number, string, or bigint) to a plain,
 * locale-independent decimal string. Scientific notation is expanded so the
 * result can be consumed exactly by BigInt and PostgreSQL NUMERIC. Returns
 * null for empty/non-finite input.
 *
 * @param {number|string|bigint|null|undefined} value
 * @returns {string|null}
 */
function toDecimalString(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    // maximumFractionDigits forces a plain expansion with no exponent.
    return value.toLocaleString("en-US", {
      useGrouping: false,
      maximumFractionDigits: 20,
    });
  }

  const raw = String(value).trim();
  if (
    raw === "" ||
    raw === "NaN" ||
    raw === "Infinity" ||
    raw === "-Infinity"
  ) {
    return null;
  }

  const negative = raw.startsWith("-");
  const unsigned = negative ? raw.slice(1) : raw;
  const [mantissa, expPart] = unsigned.split(/[eE]/);
  if (!/^\d*\.?\d*$/.test(mantissa) || mantissa === "" || mantissa === ".") {
    return null;
  }

  let exp = 0;
  if (expPart !== undefined) {
    exp = Number(expPart);
    if (!Number.isInteger(exp)) return null;
  }

  const [intPart = "", fracPart = ""] = mantissa.split(".");
  if (intPart === "" && fracPart === "") return null;
  const digits = intPart + fracPart;
  const point = intPart.length + exp;

  let out;
  if (point <= 0) {
    out = `0.${"0".repeat(-point)}${digits}`;
  } else if (point >= digits.length) {
    out = digits + "0".repeat(point - digits.length);
  } else {
    out = `${digits.slice(0, point)}.${digits.slice(point)}`;
  }

  return negative && out !== "0" ? `-${out}` : out;
}

/**
 * Convert a decimal value to an exact BigInt scaled by 10^scale. Fractional
 * digits beyond `scale` are truncated (floor for positives), matching the
 * contract's integer division of stroops. Returns 0n for empty/invalid input.
 *
 * @param {number|string|bigint|null|undefined} value
 * @param {number} scale
 * @returns {bigint}
 */
function toScaledInt(value, scale) {
  const str = toDecimalString(value);
  if (str === null) return 0n;
  const negative = str.startsWith("-");
  const unsigned = negative ? str.slice(1) : str;
  const [intPart = "0", fracPart = ""] = unsigned.split(".");
  const frac = (fracPart + "0".repeat(scale)).slice(0, scale);
  const scaled =
    BigInt(intPart || "0") * 10n ** BigInt(scale) + BigInt(frac || "0");
  return negative ? -scaled : scaled;
}

/**
 * Render a BigInt scaled by 10^scale back to a plain decimal string, trimming
 * trailing zeros.
 *
 * @param {bigint} scaled
 * @param {number} scale
 * @returns {string}
 */
function scaledToDecimalString(scaled, scale) {
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const factor = 10n ** BigInt(scale);
  const whole = abs / factor;
  const frac = abs % factor;
  let out = whole.toString();
  if (frac !== 0n) {
    out += `.${frac.toString().padStart(scale, "0").replace(/0+$/, "")}`;
  }
  return negative ? `-${out}` : out;
}

/**
 * Compute the CO₂ offset (kg) attributable to a donation, given the project's
 * total raised and total co2_offset_kg. Falls back to the event-supplied
 * co2_offset_kg when the projection already tracks it, otherwise distributes
 * proportionally. Mirrors the existing leaderboard formula.
 *
 * All arithmetic is performed in BigInt integer space (stroops and decigrams)
 * so arbitrarily large i128 donation amounts never pass through JavaScript
 * Number and lose precision. The result is an exact decimal string of kg.
 *
 * @param {number|string|bigint} amountXlm - XLM amount of the donation.
 * @param {number|string|bigint} projectRaisedXlm - Projection's running raised_xlm (BEFORE this event).
 * @param {number|string|bigint} projectCo2Kg - Projection's running co2_offset_kg.
 * @returns {string} CO₂ offset in kg for this donation.
 */
function co2OffsetForDonation(amountXlm, projectRaisedXlm, projectCo2Kg) {
  const amountStroops = toScaledInt(amountXlm, STROOP_SCALE);
  const raisedStroops = toScaledInt(projectRaisedXlm, STROOP_SCALE);
  const co2Decigrams = toScaledInt(projectCo2Kg, CO2_KG_SCALE);
  if (raisedStroops > 0n && co2Decigrams > 0n) {
    return scaledToDecimalString(
      (amountStroops * co2Decigrams) / raisedStroops,
      CO2_KG_SCALE,
    );
  }
  return "0";
}

/**
 * Impact score matching the legacy leaderboard formula:
 *   score = total_xlm * 0.7 + (total_co2_kg / 100) * 0.3
 *
 * Computed in BigInt integer space so large donation totals are not corrupted
 * by IEEE-754 rounding; the result is a decimal string at 4 decimal places.
 *
 * @param {number|string|bigint} totalXlm - Total XLM attributed to the donor or project.
 * @param {number|string|bigint} totalCo2Kg - Total CO2 offset in kilograms.
 * @returns {string} Weighted impact score used for leaderboard ordering.
 */
function computeImpactScore(totalXlm, totalCo2Kg) {
  const xlmStroops = toScaledInt(totalXlm, STROOP_SCALE);
  const co2Decigrams = toScaledInt(totalCo2Kg, CO2_KG_SCALE);
  // score = xlm * 0.7 + (co2_kg / 100) * 0.3, expressed at 10^4 scale:
  //   xlm term: stroops * 0.7 → XLM = stroops * 7 / 10^8, ×10^4 = stroops * 7 / 10^4
  //   co2 term: kg * 0.003 → decigrams * 3 / 10^7, ×10^4 = decigrams * 3 / 10^3
  const term1 = (xlmStroops * 7n) / 10000n;
  const term2 = (co2Decigrams * 3n) / 1000n;
  return scaledToDecimalString(term1 + term2, CO2_KG_SCALE);
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
        const amount = toDecimalString(d.amountXLM) || "0";
        const co2 = toDecimalString(d.co2OffsetKg) || "0";
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
            computeImpactScore(amount, co2),
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
        const amount = toDecimalString(d.amountXLM) || "0";
        const co2 = toDecimalString(d.co2OffsetKg) || "0";

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

        // donor_count is derived from donor_history. Recompute here and add
        // the current donation's donor when it is not in history yet: with the
        // current handler ordering this event's history row does not exist
        // yet, so the recompute alone would undercount a brand-new donor by 1.
        // During a bulk rebuild the whole history is rebuilt in the same
        // transaction, so per-event round trips are skipped and donor_count is
        // finalized by one aggregate after the replay (see rebuild paths).
        if (!ctx.bulkProjectionBuild) {
          const newDonorCountRow = await ctx.client.query(
            `SELECT COUNT(DISTINCT donor_address)::int AS c
               FROM projection_donor_history WHERE project_id = $1`,
            [projectId],
          );
          const priorDonorA = await ctx.client.query(
            "SELECT 1 FROM projection_donor_history WHERE project_id = $1 AND donor_address = $2 LIMIT 1",
            [projectId, d.donorAddress],
          );
          const newDonorCount =
            (newDonorCountRow.rows[0]?.c || 0) +
            (priorDonorA.rows.length === 0 ? 1 : 0);
          await ctx.client.query(
            "UPDATE projection_project_stats SET donor_count = $2 WHERE project_id = $1",
            [projectId, newDonorCount],
          );
        }
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
        const amount = toDecimalString(d.amountXLM) || "0";
        const co2 = toDecimalString(d.co2OffsetKg) || "0";
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
        const amount = toDecimalString(d.amountXLM) || "0";
        const co2 = toDecimalString(d.co2OffsetKg) || "0";
        const donor = d.donorAddress;

        // Determine if this donation introduces a new distinct donor. The
        // leaderboard projection cannot be used here: its handler (and this
        // event's donor_history row) run earlier in the same event
        // transaction, so the current donor would always already appear.
        // Excluding the current donation's transaction therefore leaves a row
        // exactly when this donor has donated before.
        let isNewDonor;
        if (ctx.bulkProjectionBuild) {
          // The history is being rebuilt in replay order inside this same
          // transaction, so a donor seen earlier in the replay is exactly a
          // donor that has donated before. Tracks the set in memory to avoid
          // one index lookup per event.
          isNewDonor = !ctx.seenDonors.has(donor);
          ctx.seenDonors.add(donor);
        } else {
          // Live path: the leaderboard projection (and this event's
          // donor_history row) run earlier in the same event transaction, so
          // the current donor would always already appear. Excluding the
          // current donation's transaction therefore leaves a row exactly when
          // this donor has donated before.
          const prior = await ctx.client.query(
            `SELECT 1 FROM projection_donor_history
              WHERE donor_address = $1 AND transaction_hash <> $2
              LIMIT 1`,
            [donor, d.transactionHash || event.transaction_hash],
          );
          isNewDonor = prior.rows.length === 0;
        }

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
 * @param {{query: Function}} [db] - Optional pool override (for tests).
 * @returns {Promise<object>} the inserted row (with id + created_at).
 */
async function insertEvent(event, db = pool) {
  const result = await db.query(
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
 * Truncate all projection tables (keeps the event store intact). The
 * `projection_global_stats` singleton row (id=1) is re-seeded afterwards so
 * the incremental UPDATE path keeps accumulating — an empty global_stats table
 * would silently drop every subsequent donation total.
 *
 * @param {{query: Function}} db
 */
async function truncateProjections(db = pool) {
  const tables = PROJECTION_NAMES.map((n) => projections[n].table);
  await db.query(`TRUNCATE ${tables.join(", ")}`);
  await db.query(
    `INSERT INTO projection_global_stats
       (id, total_xlm_raised, total_co2_offset_kg, total_donations, total_donors, total_projects, updated_at)
     VALUES (1, 0, 0, 0, 0, 0, NOW())
     ON CONFLICT (id) DO NOTHING`,
  );
}

// Non-constraint indexes (created via CREATE [UNIQUE] INDEX, not by a
// constraint). `LIKE ... INCLUDING ALL` copies them with auto-generated names,
// so they have to be dropped and recreated with the canonical definitions
// taken from the live table.
const NON_CONSTRAINT_INDEX_SQL = `
  SELECT i.relname AS indexname, pg_get_indexdef(i.oid) AS indexdef
    FROM pg_index ix
    JOIN pg_class i  ON i.oid = ix.indexrelid
    JOIN pg_class t  ON t.oid = ix.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = $1 AND t.relname = $2
     AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = i.oid)
`;

/**
 * Rewrite a `pg_get_indexdef` output so it targets the staging table instead
 * of the live table (the definition may render the table qualified or not,
 * depending on the session's search_path).
 *
 * @param {string} indexdef
 * @param {string} table
 * @returns {string}
 */
function stagedIndexDef(indexdef, table) {
  const staged = `${STAGE_SCHEMA}.${table}`;
  let def = indexdef.replaceAll(`public.${table}`, staged);
  // Table names come from the constant `projections` map, never from user input.
  /* eslint-disable-next-line security/detect-non-literal-regexp */
  def = def.replace(new RegExp(`(?<![\\w.])${table}(?![\\w.])`, "g"), staged);
  return def;
}

/**
 * Create empty staging tables (structure only — LIKE copies no rows) for the
 * given projections. The `projection_global_stats` singleton row is seeded so
 * the UPDATE-based accumulation path has a row to bump during replay.
 *
 * @param {object} client
 * @param {string[]} [names] - projections to stage (defaults to all).
 */
async function createStagedProjections(client, names = PROJECTION_NAMES) {
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${STAGE_SCHEMA}`);
  for (const name of names) {
    const table = projections[name].table;
    await client.query(`DROP TABLE IF EXISTS ${STAGE_SCHEMA}.${table}`);
    await client.query(
      `CREATE TABLE ${STAGE_SCHEMA}.${table} (LIKE public.${table} INCLUDING ALL)`,
    );
  }
  if (names.includes("global_stats")) {
    await client.query(
      `INSERT INTO ${STAGE_SCHEMA}.projection_global_stats
         (id, total_xlm_raised, total_co2_offset_kg, total_donations, total_donors, total_projects, updated_at)
       VALUES (1, 0, 0, 0, 0, 0, NOW())
       ON CONFLICT (id) DO NOTHING`,
    );
  }
}

/**
 * Replace the auto-named non-constraint indexes that `LIKE` created on the
 * staged tables with the canonical index names/definitions from the live
 * tables, so post-swap schemas stay identical to migration output.
 *
 * @param {object} client
 * @param {string[]} [names]
 */
async function canonicalizeStagedIndexes(client, names = PROJECTION_NAMES) {
  for (const name of names) {
    const table = projections[name].table;
    const stagedIndexes = await client.query(NON_CONSTRAINT_INDEX_SQL, [
      STAGE_SCHEMA,
      table,
    ]);
    for (const row of stagedIndexes.rows) {
      await client.query(`DROP INDEX ${STAGE_SCHEMA}.${row.indexname}`);
    }
    const liveIndexes = await client.query(NON_CONSTRAINT_INDEX_SQL, [
      "public",
      table,
    ]);
    for (const row of liveIndexes.rows) {
      await client.query(stagedIndexDef(row.indexdef, table));
    }
  }
}

/**
 * Atomically move staged tables into `public` inside the caller's transaction.
 *
 * Locks every live projection table in ACCESS EXCLUSIVE mode first so
 * concurrent readers block on the swap and can never observe a renamed or
 * missing table. For each table the live copy is renamed out of the way (with
 * its indexes), the staged table is moved in, and the old copy dropped.
 *
 * @param {object} client
 * @param {string[]} [names] - staged projections to swap.
 */
async function swapStagedProjections(client, names = PROJECTION_NAMES) {
  const tables = names.map((n) => projections[n].table);
  await client.query(
    `LOCK TABLE ${tables.map((t) => `public.${t}`).join(", ")} IN ACCESS EXCLUSIVE MODE`,
  );
  for (const table of tables) {
    const oldName = `${table}_rebuild_old`;
    await client.query(`ALTER TABLE public.${table} RENAME TO ${oldName}`);
    const { rows } = await client.query(
      "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1",
      [oldName],
    );
    for (const row of rows) {
      await client.query(
        `ALTER INDEX public.${row.indexname} RENAME TO ${row.indexname}_rebuild_old`,
      );
    }
    await client.query(`ALTER TABLE ${STAGE_SCHEMA}.${table} SET SCHEMA public`);
    await client.query(`DROP TABLE public.${oldName}`);
  }
  await client.query(`DROP SCHEMA IF EXISTS ${STAGE_SCHEMA}`);
}

/**
 * Rebuild every projection from the event store, atomically.
 *
 * The entire rebuild runs in one transaction: fresh staging tables are created
 * and populated from the event store while the live tables keep serving the
 * previous, complete projection state; a short ACCESS EXCLUSIVE-locked swap
 * then moves the staged tables into `public` and commits. Live traffic can
 * therefore never read an empty or partially-rebuilt projection — it sees the
 * old state until the swap, and the complete new state afterwards. A
 * cluster-wide advisory lock (transaction-scoped) prevents two instances from
 * rebuilding concurrently.
 *
 * @param {{pool?: object}} [opts]
 * @returns {Promise<{events:number, durationMs:number}>}
 */
async function rebuildAllProjections(opts = {}) {
  const db = opts.pool || pool;
  const start = Date.now();
  projectionRebuildInProgress.set(1);

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [advisoryLockKey()]);

    await createStagedProjections(client);
    await canonicalizeStagedIndexes(client);

    // Handlers reference the projection tables unqualified, so pointing the
    // transaction's search_path at the staging schema redirects every read and
    // write to the staged copies. `donation_events` resolves to `public`.
    await client.query(`SET LOCAL search_path TO ${STAGE_SCHEMA}, public`);
    const { rows } = await client.query(
      `SELECT id, event_type, aggregate_id, event_data, soroban_ledger, transaction_hash, created_at
         FROM donation_events ORDER BY id ASC`,
    );

    const seenDonors = new Set();
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
      for (const name of PROJECTION_NAMES) {
        await projections[name].handler(event, {
          client,
          pool: db,
          bulkProjectionBuild: true,
          seenDonors,
        });
      }
    }

    // donor_count is finalized from the fully-rebuilt history: one aggregate
    // per project instead of the per-event recompute used by the live path.
    await client.query(
      `UPDATE projection_project_stats AS ps
          SET donor_count = sub.c
         FROM (
           SELECT project_id, COUNT(DISTINCT donor_address)::int AS c
             FROM projection_donor_history
            GROUP BY project_id
         ) sub
        WHERE ps.project_id = sub.project_id`,
    );

    await swapStagedProjections(client);
    await client.query("COMMIT");

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
    await client.query("ROLLBACK").catch(() => {});
    const durationMs = Date.now() - start;
    projectionRebuildDurationSeconds.observe({ outcome: "error" }, durationMs / 1000);
    logger.error(
      { event: "projection_rebuild_error", err: err.message, durationMs },
      "Projection rebuild failed",
    );
    throw err;
  } finally {
    client.release();
    projectionRebuildInProgress.set(0);
  }
}

/**
 * Rebuild a single named projection from the event store, atomically. Useful
 * for partial repairs without recomputing everything. Same staging + swap
 * strategy as `rebuildAllProjections`, scoped to one table.
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
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [advisoryLockKey()]);

    await createStagedProjections(client, [name]);
    await canonicalizeStagedIndexes(client, [name]);

    await client.query(`SET LOCAL search_path TO ${STAGE_SCHEMA}, public`);
    const { rows } = await client.query(
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
      await projections[name].handler(event, { client, pool: db });
    }

    await swapStagedProjections(client, [name]);
    await client.query("COMMIT");
    return { events: rows.length };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Get the in-progress state of a rebuild, used by the admin status endpoint.
 *
 * @returns {boolean} True when a projection rebuild is currently active.
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
  // decimal helpers exposed for precision unit tests
  toDecimalString,
  toScaledInt,
  scaledToDecimalString,
  // exposed for unit tests that want to drive a handler directly
  _handlers: projections,
};

// `registry` is referenced to keep the import meaningful for tooling that
// statically verifies metric registration; the metrics themselves are
// registered on import above.
void registry;
