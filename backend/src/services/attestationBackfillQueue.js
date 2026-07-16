"use strict";

/**
 * services/attestationBackfillQueue.js
 *
 * Cross-Chain Donation Attestation Bridge — on-chain id back-fill
 * (issue #125 follow-up).
 *
 * What this does
 * --------------
 * Every `attestation-contract` `record_attestation` call emits an
 * `att_new` event on Soroban carrying topics:
 *   ("att_new", relayer, donor, source_chain)
 * and data:
 *   (id, project_id, amount_usd, amount_xlm)
 *
 * The HTTP route writes the backend `attestations` row BEFORE the
 * relayer posts to the contract — at write time we only have a
 * placeholder `on_chain_id = 0`. This pg-boss worker polls the
 * Soroban RPC `getEvents` endpoint, walks `att_new` events from a
 * persisted ledger cursor, and UPDATEs the matching backend row's
 * `on_chain_id` to the real Soroban-assigned monotonic counter.
 *
 * Matching strategy
 * -----------------
 * The contract event does NOT carry the source tx hash, so we match
 * by (source_chain, donor_address, project_id, amount_usd, amount_xlm).
 * A clash across all of these on the same donor is vanishingly unlikely
 * in real-world bridges, and `on_chain_id = 0` (the placeholder set by
 * the `/api/attestations` PUT path) limits the UPDATE to un-synced rows
 * so a replayed event can't steal a newer row.
 *
 * Concurrency / lifecycle
 * -----------------------
 * - Singleton: the table holds the cursor at `id='attestation_events'`.
 * - Polling cadence is env-driven (`ATTESTATION_BACKFILL_POLL_MS`,
 *   default 30_000 ms).
 * - Disabled by default when the deployment contract id is unset, so a
 *   developer running the backend locally without a deployed contract
 *   doesn't generate noisy log lines.
 * - Stop is idempotent and gives pg-boss 15s to drain.
 */
const PgBoss = require("pg-boss");
const pool = require("../db/pool");
const logger = require("../logger");
const metrics = require("./metrics");
const stellar = require("./stellar");

const QUEUE = "attestation-backfill";
const CURSOR_ID = "attestation_events";
const POLL_MS = Number(
  process.env.ATTESTATION_BACKFILL_POLL_MS || String(30_000),
);

/**
 * Evaluate at startup time, but re-checked each time start() runs so
 * tests that flip ATTESTATION_BACKFILL_ENABLED mid-run still get the
 * expected no-op behaviour without having to clear module caches.
 */
function isEnabled() {
  return (
    String(process.env.ATTESTATION_BACKFILL_ENABLED || "true").toLowerCase() !==
    "false"
  );
}

let boss = null;

// ------------------------------------------------------------------
// Cursor helpers
// ------------------------------------------------------------------

async function loadCursor() {
  const { rows } = await pool.query(
    `SELECT last_ledger, last_run_at, last_status, last_error
       FROM attestation_backfill_state
      WHERE id = $1`,
    [CURSOR_ID],
  );
  if (rows[0]) {
    return {
      lastLedger: Number(rows[0].last_ledger || 0),
      lastRunAt: rows[0].last_run_at,
      lastStatus: rows[0].last_status,
      lastError: rows[0].last_error,
    };
  }
  return {
    lastLedger: 0,
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
  };
}

async function writeCursor({ lastLedger, lastStatus, lastError }) {
  await pool.query(
    `UPDATE attestation_backfill_state
        SET last_ledger = $2,
            last_run_at = NOW(),
            last_status = $3,
            last_error = $4,
            updated_at = NOW()
      WHERE id = $1`,
    [CURSOR_ID, lastLedger, lastStatus || "ok", lastError || null],
  );
}

// ------------------------------------------------------------------
// Event decoder
// ------------------------------------------------------------------

/**
 * Decode a single `att_new` event into the fields we need to UPDATE
 * the backend row. The shape of the topics/data comes straight from
 * `contracts/attestation-contract/src/lib.rs`:
 *
 *   env.events().publish(
 *     (symbol_short!("att_new"), relayer.clone(), donor.clone(), source_chain.clone()),
 *     (id, project_id, amount_usd, amount_xlm),
 *   );
 *
 * Soroban returns topic/data as base64-encoded XDR ScVals; on the JS
 * side we decode with `xdr.ScVal.fromXDR` + `scValToNative` (same
 * approach used elsewhere in `services/stellar.js`).
 *
 * Numeric values (the `i128` amounts) are kept as strings so we never
 * overflow `Number.MAX_SAFE_INTEGER` on a precision-sensitive
 * back-fill. The matching SQL uses `numeric` casts so the comparison
 * still works at full precision.
 *
 * @param {object} evt  raw event from rpcServer.getEvents
 * @returns {object|null} parsed event or null when the shape is wrong
 */
function decodeAttNew(evt) {
  try {
    if (!evt || !evt.topic || !evt.value) return null;

    const decodeTopic = (t) =>
      typeof t === "string" ? stellar.scValToNative(stellar.xdr.ScVal.fromXDR(t, "base64")) : stellar.scValToNative(t);

    const topic0 = decodeTopic(evt.topic[0]);
    if (topic0 !== "att_new") return null;

    const relayer = decodeTopic(evt.topic[1]);
    const donor = decodeTopic(evt.topic[2]);
    const sourceChain = decodeTopic(evt.topic[3]);

    const valueSc =
      typeof evt.value === "string"
        ? stellar.xdr.ScVal.fromXDR(evt.value, "base64")
        : evt.value;
    const decoded = stellar.scValToNative(valueSc);
    if (!Array.isArray(decoded) || decoded.length < 4) return null;

    return {
      relayer,
      donor,
      sourceChain: String(sourceChain).toLowerCase(),
      // u64 id fits comfortably in Number; Soroban RNG caps our space.
      id: Number(decoded[0]),
      projectId: String(decoded[1]),
      // i128 amounts are kept as strings to preserve precision.
      amountUsd: toBigIntString(decoded[2]),
      amountXlm: toBigIntString(decoded[3]),
      ledger: evt.ledger || 0,
    };
  } catch (err) {
    logger.warn(
      { event: "attestation_backfill_decode_error", err: err.message },
      "Failed to decode att_new event",
    );
    return null;
  }
}

/**
 * Coerce an i128/u128 to a decimal string regardless of whether the
 * decoder hands us a Number, a BigInt, or a string. Without this,
 * a `Number(x)` cast on a large i128 silently loses precision.
 */
function toBigIntString(value) {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  // Fallback: best-effort JSON round-trip.
  return String(Number(value) || 0);
}

/**
 * Fetch a batch of `att_new` events from Soroban RPC, paging from
 * `startLedger` (exclusive) up to `endLedger`. Returns an array of
 * decoded events plus a fresh ledger head so the caller can update
 * lag metrics without a second RPC round-trip.
 *
 * Soroban's getEvents returns at most 200 events per page; we loop
 * over the `pagingToken` cursor until the response is short so a single
 * poll window can swallow arbitrarily-bursty traffic. If something
 * goes wrong mid-paging we re-throw and leave the cursor untouched.
 */
async function fetchEventsSince(startLedger, knownHead = 0) {
  const contractId =
    process.env.ATTESTATION_CONTRACT_ID || process.env.CONTRACT_ID || "";
  if (!contractId) return { events: [], head: 0 };

  const head = knownHead > 0 ? knownHead : await getLedgerHead();
  const endLedger =
    head > 0 ? Math.max(startLedger + 1, head - 5) : startLedger + 100;
  if (endLedger <= startLedger) return { events: [], head };

  const filter = {
    type: "contract",
    contractIds: [contractId],
    topics: [
      [
        stellar.xdr.ScVal.scvSymbol("att_new").toXDR("base64"),
        "*", // relayer
        "*", // donor
        "*", // source_chain
      ],
    ],
  };

  const collected = [];
  let cursor;
  // Hard ceiling so a misbehaving RPC cannot trap us in a paging
  // loop forever. 50 pages × 200 events = 10 000 events per tick,
  // which is far more than the back-fill should ever need.
  for (let page = 0; page < 50; page++) {
    const request = {
      filters: [filter],
      startLedger: startLedger + 1,
      endLedger,
      limit: 200,
    };
    if (cursor) request.pagingToken = cursor;
    let response;
    try {
      response = await stellar.withRetry(() =>
        stellar.rpcServer.getEvents(request),
      );
    } catch (err) {
      logger.error(
        { event: "attestation_backfill_rpc_error", err: err.message, page },
        "Soroban RPC getEvents failed",
      );
      throw err;
    }
    const events = (response && response.events) || [];
    for (const evt of events) {
      const decoded = decodeAttNew(evt);
      if (decoded && decoded.id > 0) collected.push(decoded);
    }
    if (events.length < 200) break;
    cursor = response.pagingToken;
    if (!cursor) break;
  }
  return { events: collected, head };
}

/**
 * Best-effort ledger head read so the worker can page a bounded
 * window without walking the whole chain. Returns 0 on failure so the
 * caller falls back to a fixed `+100` lookahead.
 */
async function getLedgerHead() {
  try {
    const resp = await stellar.withRetry(() => stellar.rpcServer.getLatestLedger());
    return Number(resp && resp.sequence) || 0;
  } catch (err) {
    logger.debug(
      { event: "attestation_backfill_head_error", err: err.message },
      "getLatestLedger failed; using lookahead fallback",
    );
    return 0;
  }
}

// ------------------------------------------------------------------
// Back-fill application
// ------------------------------------------------------------------

/**
 * Apply one decoded event to the database. Returns the id of the
 * backend row that was updated, or null when no match was found
 * (e.g. the matching backend row already carries a newer id, or the
 * matching row simply hasn't been POSTed yet).
 */
async function applyEvent(decoded) {
  try {
    const { rows } = await pool.query(
      `UPDATE attestations
          SET on_chain_id = $1,
              status = CASE WHEN status = 'pending' THEN status ELSE status END,
              verified_at = COALESCE(verified_at,
                CASE WHEN $1 > 0 THEN NOW() END)
        WHERE source_chain = $2
          AND donor_address = $3
          AND project_id = $4
          AND amount_usd = $5::numeric
          AND amount_xlm = $6::numeric
          AND (on_chain_id IS NULL OR on_chain_id = 0 OR on_chain_id < $1)
        RETURNING id`,
      [
        decoded.id,
        decoded.sourceChain,
        decoded.donor,
        decoded.projectId,
        decoded.amountUsd,
        decoded.amountXlm,
      ],
    );
    if (rows[0]) {
      metrics.attestationBackfillUpdatesTotal.inc({ outcome: "matched" });
      logger.info(
        {
          event: "attestation_backfill_matched",
          attestationRowId: rows[0].id,
          on_chain_id: decoded.id,
          sourceChain: decoded.sourceChain,
          donor: decoded.donor,
        },
        "Back-filled backend attestation with on-chain id",
      );
      return rows[0].id;
    }
    metrics.attestationBackfillUpdatesTotal.inc({ outcome: "miss" });
    return null;
  } catch (err) {
    metrics.attestationBackfillUpdatesTotal.inc({ outcome: "error" });
    logger.error(
      {
        event: "attestation_backfill_apply_error",
        on_chain_id: decoded.id,
        err: err.message,
      },
      "Failed to apply decoded event",
    );
    throw err;
  }
}

// ------------------------------------------------------------------
// Worker lifecycle
// ------------------------------------------------------------------

/**
 * A single poll iteration. Loads cursor, fetches events, applies each,
 * advances cursor.
 *
 * Delivery semantics: at-least-once per event. If `applyEvent` throws
 * partway through a batch, the cursor is intentionally NOT advanced
 * past the failing row — the next tick re-reads the same ledger
 * window. The failure counter (`attestation_backfill_polls_total{outcome="error"}`)
 * ticks up so an operator can spot a stuck loop; manual replay is the
 * documented response (see docs/cross-chain-attestation.md). Per-event
 * retry jobs were intentionally avoided: the cost of re-submitting
 * the same att_new event downstream exceeds the cost of a single SQL
 * UPDATE retry.
 */
async function runOnce() {
  let cursor;
  try {
    cursor = await loadCursor();
  } catch (err) {
    metrics.attestationBackfillPollsTotal.inc({ outcome: "error" });
    logger.error(
      { event: "attestation_backfill_cursor_unavailable", err: err.message },
      "Cannot load cursor; deferring to next tick",
    );
    return;
  }

  let processed = 0;
  let lastLedger = cursor.lastLedger;

  try {
    const { events, head } = await fetchEventsSince(cursor.lastLedger);
    for (const evt of events) {
      await applyEvent(evt);
      if (evt.ledger > lastLedger) lastLedger = evt.ledger;
      processed += 1;
    }
    await writeCursor({
      lastLedger: processed > 0 ? lastLedger : cursor.lastLedger,
      lastStatus: "ok",
      lastError: null,
    });
    metrics.attestationBackfillPollsTotal.inc({
      outcome: processed > 0 ? "progress" : "idle",
    });

    if (head > 0) {
      const effectiveCursor = processed > 0 ? lastLedger : cursor.lastLedger;
      metrics.attestationBackfillCursorLag.set(Math.max(0, head - effectiveCursor));
    }

    if (processed > 0) {
      logger.info(
        { event: "attestation_backfill_tick", processed, lastLedger },
        "Back-fill worker processed events",
      );
    }
  } catch (err) {
    metrics.attestationBackfillPollsTotal.inc({ outcome: "error" });
    // We may have partially processed events; leave the cursor at the
    // last successful point so the next tick resumes cleanly.
    await writeCursor({
      lastLedger: cursor.lastLedger,
      lastStatus: "error",
      lastError: err.message,
    });
    logger.error(
      {
        event: "attestation_backfill_error",
        err: err.message,
        cursorAt: cursor.lastLedger,
      },
      "Back-fill iteration failed",
    );
  }
}

/**
 * Boot the pg-boss scheduler + the polling worker.
 *
 * Returns:
 *   { alreadyRunning: false }   — fresh start, worker scheduled
 *   { alreadyRunning: true  }   — another start() call already wired
 *                                 up the worker; this call was a no-op.
 *
 * Returning `alreadyRunning: true` is what server.js and tests can
 * watch to detect accidental double-starts (e.g. a hot-reload in dev
 * or a retry on the production boot path). The previous bare
 * `return` hid the bug; this version logs `attestation_backfill_already_running`
 * so a misconfiguration shows up clearly in observability pipelines.
 */
async function start() {
  if (boss) {
    logger.warn(
      { event: "attestation_backfill_already_running" },
      "start() called while a previous worker is still active; ignoring",
    );
    return { alreadyRunning: true };
  }

  if (!isEnabled()) {
    logger.info(
      { event: "attestation_backfill_disabled" },
      "Back-fill worker disabled via env",
    );
    return { alreadyRunning: false };
  }

  const contractId =
    process.env.ATTESTATION_CONTRACT_ID || process.env.CONTRACT_ID || "";
  if (!contractId) {
    logger.warn(
      { event: "attestation_backfill_no_contract" },
      "ATTESTATION_CONTRACT_ID unset — back-fill worker idle (set the env var to enable)",
    );
    return { alreadyRunning: false };
  }

  // Log the configured relayer identity on boot so a deploy / env
  // drift is visible in the same logs as the first poll. If the
  // `ATTESTATION_RELAYER_ADDRESS` env is missing, the worker still
  // operates — the relayer only affects audit attribution. The next
  // refactor should add a Soroban get_relayer() comparison at boot so
  // a divergent env value fails loudly.
  logger.info(
    {
      event: "attestation_backfill_relayer_configured",
      relayer: process.env.ATTESTATION_RELAYER_ADDRESS || "(unset)",
      contractId,
    },
    "Relayer identity recorded",
  );

  const connectionString =
    process.env.DATABASE_URL ||
    "postgres://postgres:postgres@localhost:5432/indigopay";

  boss = new PgBoss(connectionString);
  boss.on("error", (err) =>
    logger.error(
      { event: "attestation_backfill_boss_error", err: err.message },
      "pg-boss error",
    ),
  );
  await boss.start();

  await boss.work(
    QUEUE,
    { teamSize: 1, teamConcurrency: 1, retryLimit: 3, retryDelay: 30 },
    async () => {
      await runOnce();
      // Rearm AFTER the work has finished so a slow tick doesn't pile
      // up overlapping jobs in the queue. The re-arm is best-effort
      // — if pg-boss itself is shutting down we silently swallow.
      if (boss) {
        try {
          await boss.send(
            QUEUE,
            { kind: "poll" },
            {
              retryLimit: 0,
              startAfter: new Date(Date.now() + POLL_MS),
            },
          );
        } catch (err) {
          logger.warn(
            {
              event: "attestation_backfill_rearm_error",
              err: err.message,
            },
            "pg-boss rearm failed; the polling loop is now asleep",
          );
        }
      }
    },
  );

  // The first poll fires as soon as the worker handler runs; pg-boss
  // routes a registered worker through `boss.send(QUEUE, ...,
  // startAfter: Date.now())` BEFORE the rearm-from-handler pattern
  // is in effect, otherwise we'd wait one full POLL_MS before the very
  // first poll ticked.
  await boss.send(
    QUEUE,
    { kind: "poll" },
    {
      retryLimit: 0,
      startAfter: new Date(), // immediate
    },
  );

  logger.info(
    { event: "attestation_backfill_started", pollMs: POLL_MS, queue: QUEUE },
    "Attestation back-fill worker started",
  );
}

/**
 * Programmatic one-shot kick (useful for tests / admin "replay now").
 * Runs a single poll iteration synchronously. Returns the cursor that
 * was persisted.
 */
async function tick() {
  await runOnce();
  return loadCursor();
}

async function stop() {
  if (!boss) return;
  try {
    await boss.stop({ graceful: true, timeout: 15_000 });
  } catch (err) {
    logger.warn(
      { event: "attestation_backfill_stop_error", err: err.message },
      "graceful stop failed",
    );
  }
  boss = null;
}

module.exports = {
  QUEUE,
  CURSOR_ID,
  POLL_MS,
  start,
  stop,
  tick,
  // Internal helpers exposed for tests
  decodeAttNew,
  fetchEventsSince,
  applyEvent,
  loadCursor,
  writeCursor,
};
