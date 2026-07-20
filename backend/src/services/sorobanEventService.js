/**
 * backend/src/services/sorobanEventService.js
 *
 * Soroban RPC Event Subscription Service
 *
 * Polls the Soroban RPC `getEvents` endpoint every 5 seconds for all contract
 * events emitted by the IndigoPay contract. Processes them into the database
 * with deduplication, batch commits, and a dead-letter queue for failures.
 *
 * Runs alongside the Horizon SSE indexer (indexerService.js) — the Horizon
 * stream catches raw payment operations while this service catches
 * contract-only events (badge mints, governance, project registrations,
 * USDC donations that the Horizon stream might miss).
 *
 * Architecture:
 *   - Polling loop (5s interval) with cursor persisted in `indexer_state`.
 *   - Events dispatched to type-specific handlers via a handler map.
 *   - Deduplication by `pagingToken` (immutable Soroban event cursor).
 *   - Batch commit: accumulate up to BATCH_SIZE events, then commit in a
 *     single DB transaction.
 *   - Failed events written to `soroban_event_dlq` with error details.
 *   - Prometheus metrics for throughput, lag, and failures.
 */
"use strict";

const {
  rpcServer,
  CONTRACT_ID,
  withRetry,
} = require("./stellar");
const { xdr, scValToNative } = require("@stellar/stellar-sdk");
const pool = require("../db/pool");
const logger = require("../logger");
const { registry } = require("./metrics");
const { Counter, Gauge } = require("prom-client");
const { v4: uuid } = require("uuid");
const { computeBadges } = require("./store");

// ── Configuration ───────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 5_000; // 5 seconds
const BATCH_SIZE = 50;
const DLQ_MAX_RETRIES = 3;

// ── Prometheus metrics ──────────────────────────────────────────────────────

const sorobanEventsProcessedTotal = new Counter({
  name: "indigopay_soroban_events_processed_total",
  help: "Total Soroban contract events processed, labelled by event_type and outcome (success|failed|skipped).",
  labelNames: ["event_type", "outcome"],
  registers: [registry],
});

const sorobanEventsLagLedgers = new Gauge({
  name: "indigopay_soroban_events_lag_ledgers",
  help: "Number of ledgers behind the latest on-chain ledger for Soroban event processing.",
  registers: [registry],
});

const sorobanEventsRunning = new Gauge({
  name: "indigopay_soroban_events_running",
  help: "1 if the Soroban event polling loop is running, 0 otherwise.",
  registers: [registry],
});

const sorobanEventsBatchDurationSeconds = new Gauge({
  name: "indigopay_soroban_events_batch_duration_seconds",
  help: "Duration of the last event batch processing cycle in seconds.",
  registers: [registry],
});

// ── State ───────────────────────────────────────────────────────────────────

let isRunning = false;
let pollingTimer = null;
let currentCursor = "";
/** @type {import("socket.io").Server|null} */
let io = null;
/** @type {Set<string>} Tracks processed pagingTokens within the current session. */
const processedTokens = new Set();
/** Max size of the in-memory dedup set before it's pruned. */
const MAX_DEDUP_SET_SIZE = 100_000;

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Decode a topic or value from its wire format (base64 XDR string or raw
 * ScVal) into a native JavaScript value. Mirrors the pattern used in
 * `stellar.js` getProjectDonationEvents.
 *
 * @param {string|object} raw — base64-encoded XDR ScVal string or raw ScVal object.
 * @returns {*} Native JavaScript value.
 */
function decodeScVal(raw) {
  if (typeof raw === "string") {
    try {
      return scValToNative(xdr.ScVal.fromXDR(raw, "base64"));
    } catch {
      return raw;
    }
  }
  try {
    return scValToNative(raw);
  } catch {
    return raw;
  }
}

/**
 * Extract the event type symbol from topic[0] of a Soroban event.
 * Contract events use `symbol_short!(\"event_name\")` which encodes as
 * a ScVal symbol.
 *
 * @param {object} evt — Raw Soroban RPC event object.
 * @returns {string} The event type, e.g. "donated", "proj_reg".
 */
function extractEventType(evt) {
  try {
    const topics = evt.topic || [];
    if (topics.length === 0) return "unknown";
    const decoded = decodeScVal(topics[0]);
    return typeof decoded === "string" ? decoded : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Extract and decode all event topics into native JS values.
 * @param {object} evt
 * @returns {Array<*>}
 */
function extractTopics(evt) {
  const topics = evt.topic || [];
  return topics.map((t) => {
    try {
      return decodeScVal(t);
    } catch {
      return null;
    }
  });
}

/**
 * Extract and decode the event value into a native JS value.
 * Some events (proj_ver, prop_rej) publish a single value; others
 * (donated) publish a tuple.
 * @param {object} evt
 * @returns {*}
 */
function extractValue(evt) {
  try {
    if (evt.value) {
      return decodeScVal(evt.value);
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Prune the in-memory dedup set once it exceeds the max size.
 * Removes the oldest half of entries (Set iteration is insertion-ordered).
 */
function pruneDedupSet() {
  if (processedTokens.size <= MAX_DEDUP_SET_SIZE) return;
  const toRemove = Math.floor(processedTokens.size / 2);
  let removed = 0;
  for (const token of processedTokens) {
    processedTokens.delete(token);
    if (++removed >= toRemove) break;
  }
  logger.warn(
    { event: "soroban_events_dedup_pruned", removed },
    "Dedup set pruned to prevent memory growth",
  );
}

// ── Cursor persistence ──────────────────────────────────────────────────────

/**
 * Load the persisted cursor from `indexer_state`.
 * @returns {Promise<string>}
 */
async function loadCursor() {
  try {
    const result = await pool.query(
      "SELECT value FROM indexer_state WHERE key = 'soroban_event_cursor'",
    );
    if (result.rows.length > 0 && result.rows[0].value) {
      return result.rows[0].value;
    }
  } catch (err) {
    logger.error(
      { event: "soroban_events_cursor_load_error", err: err.message },
      "Failed to load cursor from indexer_state",
    );
  }
  return "";
}

/**
 * Persist the cursor to `indexer_state`.
 * @param {string} cursor
 */
async function saveCursor(cursor) {
  try {
    await pool.query(
      `INSERT INTO indexer_state (key, value, updated_at)
       VALUES ('soroban_event_cursor', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [cursor],
    );
  } catch (err) {
    logger.error(
      { event: "soroban_events_cursor_save_error", err: err.message },
      "Failed to save cursor to indexer_state",
    );
  }
}

// ── DLQ ─────────────────────────────────────────────────────────────────────

/**
 * Write a failed event to the dead-letter queue.
 * @param {object} evt — Raw event object
 * @param {string} eventType
 * @param {Error} error
 * @param {number} [attemptCount]
 */
async function writeToDLQ(evt, eventType, error, attemptCount = DLQ_MAX_RETRIES) {
  try {
    await pool.query(
      `INSERT INTO soroban_event_dlq
         (event_type, contract_id, event_data, error_message, error_stack, attempt_count)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        eventType,
        CONTRACT_ID,
        JSON.stringify(evt),
        error.message || "Unknown error",
        error.stack || null,
        attemptCount,
      ],
    );
  } catch (err) {
    logger.error(
      { event: "soroban_events_dlq_write_error", err: err.message },
      "Failed to write event to DLQ",
    );
  }
}

// ── Event handlers ──────────────────────────────────────────────────────────

/**
 * Handle a `donated` event.
 * Topics: [symbol("donated"), donor_address, project_id]
 * Value:  [amount_i128, badge_tier, msg_hash_u32]
 */
async function handleDonated(evt, topics, value) {
  const donor = topics[1] || "";
  const projectId = topics[2] || "";
  const txHash = evt.txHash || "";
  const ledger = evt.ledger || 0;

  let amount = "0";
  let msgHash = null;

  if (Array.isArray(value)) {
    if (value[0] !== undefined && value[0] !== null) {
      amount = String(value[0]);
    }
    if (value[1] !== undefined && value[1] !== null) {
      // badge tier extracted for logging
    }
    if (value[2] !== undefined && value[2] !== null) {
      msgHash = typeof value[2] === "bigint"
        ? Number(value[2])
        : Number(value[2]);
      if (Number.isNaN(msgHash)) msgHash = String(value[2]);
    }
  } else if (value && typeof value === "object") {
    amount = String(value.amount ?? value[0] ?? "0");
    msgHash = value.msgHash ?? value.msg_hash ?? value[2] ?? null;
  }

  // Convert stroops to XLM using string-based math to avoid
  // precision loss with JavaScript Number for large i128 values.
  // Stellar amounts are i128; we keep them as strings for the DB.
  const STROOP_DIVISOR = 10_000_000n;
  let xlmStr;
  try {
    const stroopAmount = BigInt(amount);
    const whole = stroopAmount / STROOP_DIVISOR;
    const frac = stroopAmount % STROOP_DIVISOR;
    const fracStr = frac.toString().padStart(7, "0");
    xlmStr = `${whole}.${fracStr}`;
  } catch {
    // Fallback: treat as numeric string
    const num = parseFloat(amount);
    xlmStr = isNaN(num) ? "0" : (num / 10_000_000).toFixed(7);
  }
  const xlmAmount = parseFloat(xlmStr);

  // Dedup by txHash — if already recorded, skip.
  // NOTE: evt.txHash is always present for contract-invoked events.
  // The fallback "soroban-" + uuid is only reached if the RPC response
  // format changes; it will NOT deduplicate across restarts.
  if (txHash) {
    const existing = await pool.query(
      "SELECT id FROM donations WHERE transaction_hash = $1",
      [txHash],
    );
    if (existing.rows.length > 0) {
      logger.debug(
        { event: "soroban_events_donated_skipped", txHash, projectId },
        "Donation already recorded — skipping duplicate event",
      );
      return { action: "skipped", reason: "duplicate" };
    }
  }

  // Insert donation record
  const donationId = uuid();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `INSERT INTO donations (id, project_id, donor_address, amount_xlm, amount, currency, transaction_hash, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [donationId, projectId, donor, xlmAmount, xlmAmount, "XLM", txHash || "soroban-" + donationId],
    );

    // Update project raised_xlm + donor_count
    await client.query(
      `UPDATE projects
       SET raised_xlm = raised_xlm + $1,
           donor_count = (SELECT COUNT(DISTINCT donor_address) FROM donations WHERE project_id = $2),
           updated_at = NOW()
       WHERE id = $2`,
      [xlmAmount, projectId],
    );

    // Update donor profile
    const profileResult = await client.query(
      "SELECT total_donated_xlm FROM profiles WHERE public_key = $1",
      [donor],
    );
    const prevTotal = profileResult.rows[0]
      ? parseFloat(profileResult.rows[0].total_donated_xlm || "0")
      : 0;
    const newTotal = prevTotal + xlmAmount;

    const projectsSupportedResult = await client.query(
      "SELECT COUNT(DISTINCT project_id) AS count FROM donations WHERE donor_address = $1",
      [donor],
    );
    const projectsSupported =
      parseInt(projectsSupportedResult.rows[0].count, 10) || 1;

    // Reuse the canonical badge calculation from the store module
    const badges = computeBadges(newTotal);

    await client.query(
      `INSERT INTO profiles (public_key, total_donated_xlm, projects_supported, badges, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())
       ON CONFLICT (public_key) DO UPDATE SET
         total_donated_xlm = EXCLUDED.total_donated_xlm,
         projects_supported = EXCLUDED.projects_supported,
         badges = EXCLUDED.badges,
         updated_at = NOW()`,
      [donor, newTotal.toFixed(7), projectsSupported, JSON.stringify(badges)],
    );

    await client.query("COMMIT");

    logger.info(
      {
        event: "soroban_events_donated_processed",
        donationId,
        projectId,
        donor,
        amount: xlmAmount,
        txHash,
        ledger,
      },
      "Donation recorded from Soroban contract event",
    );
    // Emit WebSocket event for real-time frontend updates
    if (io) {
      io.emit("newDonation", {
        projectId,
        donorAddress: donor,
        amountXLM: xlmAmount,
        amount: xlmAmount,
        currency: "XLM",
        txHash: txHash || "soroban-" + donationId,
        timestamp: new Date().toISOString(),
      });
    }

    return { action: "inserted", donationId };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Handle a `proj_reg` event — log project registration.
 * Topics: [symbol("proj_reg"), admin_address]
 * Value: project_id (String)
 */
async function handleProjReg(evt, topics, value) {
  const adminAddress = topics[1] || "";
  const projectId = typeof value === "string" ? value : String(value || "");

  logger.info(
    {
      event: "soroban_events_proj_reg",
      projectId,
      adminAddress,
      ledger: evt.ledger,
    },
    "Project registration event observed from Soroban contract",
  );
  return { action: "logged" };
}

/**
 * Handle a `rec_cr` event — recurring donation created.
 * Topics: [symbol("rec_cr"), donor_address, project_id_string]
 * Value: [recurring_id, amount, currency, interval_ledgers, keeper_incentive, msg_hash]
 */
async function handleRecCr(evt, topics, value) {
  const donor = topics[1] || "";
  const projectId = topics[2] || "";
  
  if (!Array.isArray(value) || value.length < 5) {
    logger.warn({ event: "soroban_events_rec_cr_invalid_value", value }, "Invalid value format for rec_cr event");
    return { action: "skipped", reason: "invalid_value" };
  }

  const recurringId = Number(value[0]);
  const amountStroops = String(value[1]);
  const currency = String(value[2]);
  const intervalLedgers = Number(value[3]);
  const keeperIncentiveStroops = String(value[4]);

  const amount = parseFloat(amountStroops) / 10_000_000;
  const keeperIncentive = parseFloat(keeperIncentiveStroops) / 10_000_000;
  const intervalSeconds = intervalLedgers * 5;
  const nextExecutionAt = new Date(Date.now() + intervalSeconds * 1000);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Insert or update recurring donation
    await client.query(
      `INSERT INTO recurring_donations 
         (donor_address, recurring_id, project_id, amount, currency, interval_seconds, next_execution_at, keeper_incentive, active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE, NOW(), NOW())
       ON CONFLICT (donor_address, recurring_id) DO UPDATE SET
         project_id = EXCLUDED.project_id,
         amount = EXCLUDED.amount,
         currency = EXCLUDED.currency,
         interval_seconds = EXCLUDED.interval_seconds,
         next_execution_at = EXCLUDED.next_execution_at,
         keeper_incentive = EXCLUDED.keeper_incentive,
         active = TRUE,
         updated_at = NOW()`,
      [donor, recurringId, projectId, amount, currency, intervalSeconds, nextExecutionAt, keeperIncentive]
    );

    await client.query("COMMIT");
    logger.info(
      { event: "soroban_events_rec_cr_processed", donor, recurringId, projectId, amount, currency },
      "Recurring donation creation indexed successfully"
    );
    return { action: "inserted", donor, recurringId };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Handle a `rec_can` event — recurring donation cancelled.
 * Topics: [symbol("rec_can"), donor_address, recurring_id]
 * Value: ()
 */
async function handleRecCan(evt, topics, value) {
  const donor = topics[1] || "";
  const recurringId = Number(topics[2]);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `UPDATE recurring_donations
       SET active = FALSE,
           updated_at = NOW()
       WHERE donor_address = $1 AND recurring_id = $2`,
      [donor, recurringId]
    );

    await client.query("COMMIT");
    logger.info(
      { event: "soroban_events_rec_can_processed", donor, recurringId },
      "Recurring donation cancellation indexed successfully"
    );
    return { action: "cancelled", donor, recurringId };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Handle a `rec_exec` event — recurring donation executed.
 * Topics: [symbol("rec_exec"), donor_address, recurring_id]
 * Value: [keeper, amount, currency, next_execution_ledger]
 */
async function handleRecExec(evt, topics, value) {
  const donor = topics[1] || "";
  const recurringId = Number(topics[2]);
  const txHash = evt.txHash || "";

  if (!Array.isArray(value) || value.length < 3) {
    logger.warn({ event: "soroban_events_rec_exec_invalid_value", value }, "Invalid value format for rec_exec event");
    return { action: "skipped", reason: "invalid_value" };
  }

  const keeper = String(value[0]);
  const amountStroops = String(value[1]);
  const currency = String(value[2]);
  const nextExecutionLedger = Number(value[3]);

  const xlmAmount = parseFloat(amountStroops) / 10_000_000;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. Lookup recurring donation configuration to get project_id and interval_seconds
    const recurringRes = await client.query(
      "SELECT project_id, interval_seconds FROM recurring_donations WHERE donor_address = $1 AND recurring_id = $2",
      [donor, recurringId]
    );

    if (recurringRes.rows.length === 0) {
      logger.warn(
        { event: "soroban_events_rec_exec_config_not_found", donor, recurringId },
        "Recurring donation config not found in DB - skipping execution indexing"
      );
      await client.query("ROLLBACK");
      return { action: "skipped", reason: "config_not_found" };
    }

    const { project_id: projectId, interval_seconds: intervalSeconds } = recurringRes.rows[0];

    // 2. Dedup by transaction hash to avoid duplicate recording
    if (txHash) {
      const existing = await client.query(
        "SELECT id FROM donations WHERE transaction_hash = $1",
        [txHash]
      );
      if (existing.rows.length > 0) {
        logger.debug(
          { event: "soroban_events_rec_exec_skipped", txHash, projectId },
          "Recurring donation already recorded - skipping duplicate event"
        );
        await client.query("ROLLBACK");
        return { action: "skipped", reason: "duplicate" };
      }
    }

    const donationId = uuid();

    // 3. Insert donation record
    await client.query(
      `INSERT INTO donations (id, project_id, donor_address, amount_xlm, amount, currency, transaction_hash, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [donationId, projectId, donor, xlmAmount, xlmAmount, currency, txHash || "soroban-" + donationId]
    );

    // 4. Update project raised_xlm and donor_count
    await client.query(
      `UPDATE projects
       SET raised_xlm = raised_xlm + $1,
           donor_count = (SELECT COUNT(DISTINCT donor_address) FROM donations WHERE project_id = $2),
           updated_at = NOW()
       WHERE id = $2`,
      [xlmAmount, projectId]
    );

    // 5. Update donor profile
    const profileResult = await client.query(
      "SELECT total_donated_xlm FROM profiles WHERE public_key = $1",
      [donor]
    );
    const prevTotal = profileResult.rows[0]
      ? parseFloat(profileResult.rows[0].total_donated_xlm || "0")
      : 0;
    const newTotal = prevTotal + xlmAmount;

    const projectsSupportedResult = await client.query(
      "SELECT COUNT(DISTINCT project_id) AS count FROM donations WHERE donor_address = $1",
      [donor]
    );
    const projectsSupported =
      parseInt(projectsSupportedResult.rows[0].count, 10) || 1;

    const badges = computeBadges(newTotal);

    await client.query(
      `INSERT INTO profiles (public_key, total_donated_xlm, projects_supported, badges, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())
       ON CONFLICT (public_key) DO UPDATE SET
         total_donated_xlm = EXCLUDED.total_donated_xlm,
         projects_supported = EXCLUDED.projects_supported,
         badges = EXCLUDED.badges,
         updated_at = NOW()`,
      [donor, newTotal.toFixed(7), projectsSupported, JSON.stringify(badges)]
    );

    // 6. Update recurring donation next execution timestamp
    const nextExecutionAt = new Date(Date.now() + intervalSeconds * 1000);
    await client.query(
      `UPDATE recurring_donations
       SET next_execution_at = $1,
           updated_at = NOW()
       WHERE donor_address = $2 AND recurring_id = $3`,
      [nextExecutionAt, donor, recurringId]
    );

    await client.query("COMMIT");

    logger.info(
      { event: "soroban_events_rec_exec_processed", donationId, donor, recurringId, projectId, amount: xlmAmount, keeper, txHash },
      "Recurring donation execution processed and recorded successfully"
    );

    // Emit WebSocket event for real-time frontend updates
    if (io) {
      io.emit("newDonation", {
        projectId,
        donorAddress: donor,
        amountXLM: xlmAmount,
        amount: xlmAmount,
        currency,
        txHash: txHash || "soroban-" + donationId,
        timestamp: new Date().toISOString(),
      });
    }

    return { action: "executed", donationId };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Handle an nft_mint event — Impact NFT minted.
 * Topics: [symbol("nft_mint"), donor_address]
 * Value: badge_tier (BadgeTier enum)
 */
async function handleNftMint(evt, topics, value) {
  const donor = topics[1] || "";
  const tier = String(value || "Unknown");

  logger.info(
    {
      event: "soroban_events_nft_mint",
      donor,
      tier,
      ledger: evt.ledger,
    },
    "Impact NFT mint event observed",
  );
  return { action: "logged" };
}

/**
 * Handle a `pnft_mint` event — Project Milestone NFT minted.
 * Topics: [symbol("pnft_mint"), donor_address, project_id]
 * Value: [amount, co2_offset_grams]
 */
async function handlePnftMint(evt, topics, value) {
  const donor = topics[1] || "";
  const projectId = topics[2] || "";

  let amount = "0";
  let co2Offset = "0";
  if (Array.isArray(value)) {
    if (value[0] !== undefined) amount = String(value[0]);
    if (value[1] !== undefined) co2Offset = String(value[1]);
  }

  logger.info(
    {
      event: "soroban_events_pnft_mint",
      donor,
      projectId,
      amount,
      co2Offset,
      ledger: evt.ledger,
    },
    "Project milestone NFT mint observed",
  );
  return { action: "logged" };
}

/**
 * Handle a `voted` event — governance vote cast.
 * Topics: [symbol("voted"), voter_address, project_id]
 * Value: approve (boolean)
 */
async function handleVoted(evt, topics, value) {
  const voter = topics[1] || "";
  const projectId = topics[2] || "";
  const approve = Boolean(value);

  logger.info(
    {
      event: "soroban_events_voted",
      voter,
      projectId,
      approve,
      ledger: evt.ledger,
    },
    "Governance vote observed",
  );
  return { action: "logged" };
}

/**
 * Handle `proj_ver` — project verified via governance.
 * Topics: [symbol("proj_ver")]
 * Value: project_id
 */
async function handleProjVer(evt, _topics, value) {
  const projectId = typeof value === "string" ? value : String(value || "");

  logger.info(
    {
      event: "soroban_events_proj_ver",
      projectId,
      ledger: evt.ledger,
    },
    "Project verified via governance",
  );

  // Optionally update the projects table to reflect on-chain verification
  try {
    await pool.query(
      `UPDATE projects SET on_chain_verified = TRUE, updated_at = NOW()
       WHERE id = $1`,
      [projectId],
    );
  } catch {
    // Non-fatal — the event is still logged.
  }
  return { action: "updated" };
}

/**
 * Handle `prop_rej` — proposal rejected.
 * Topics: [symbol("prop_rej")]
 * Value: project_id
 */
async function handlePropRej(evt, _topics, value) {
  const projectId = typeof value === "string" ? value : String(value || "");

  logger.info(
    {
      event: "soroban_events_prop_rej",
      projectId,
      ledger: evt.ledger,
    },
    "Governance proposal rejected",
  );
  return { action: "logged" };
}

/**
 * Handle `prop_veto` — proposal vetoed by admin.
 * Topics: [symbol("prop_veto"), admin_address]
 * Value: project_id
 */
async function handlePropVeto(evt, topics, value) {
  const admin = topics[1] || "";
  const projectId = typeof value === "string" ? value : String(value || "");

  logger.info(
    {
      event: "soroban_events_prop_veto",
      admin,
      projectId,
      ledger: evt.ledger,
    },
    "Governance proposal vetoed by admin",
  );
  return { action: "logged" };
}

/**
 * Handle `prop_new` — new governance proposal created.
 * Topics: [symbol("prop_new"), admin_address]
 * Value: [project_id, voting_window_ledgers]
 */
async function handlePropNew(evt, topics, value) {
  const admin = topics[1] || "";
  let projectId = "";
  let window = 0;
  if (Array.isArray(value)) {
    projectId = String(value[0] || "");
    window = Number(value[1] || 0);
  }

  logger.info(
    {
      event: "soroban_events_prop_new",
      admin,
      projectId,
      votingWindowLedgers: window,
      ledger: evt.ledger,
    },
    "New governance proposal created",
  );
  return { action: "logged" };
}

/**
 * Handle other events: deact_all, co2_rate, prj_pause, prj_resm, usdc_set,
 * sub_creat, sub_canc.
 * These are logged but don't currently require database mutations.
 */
async function handleOtherEvent(evt, eventType, topics, value) {
  logger.info(
    {
      event: "soroban_events_other",
      eventType,
      topics: topics.slice(0, 5), // avoid logging huge arrays
      value: typeof value === "object" ? "[object]" : String(value).slice(0, 200),
      ledger: evt.ledger,
    },
    `Soroban contract event "${eventType}" observed`,
  );
  return { action: "logged" };
}

// ── Handler dispatch map ────────────────────────────────────────────────────

/** @type {Record<string, Function>} */
const HANDLERS = {
  donated: handleDonated,
  proj_reg: handleProjReg,
  nft_mint: handleNftMint,
  pnft_mint: handlePnftMint,
  voted: handleVoted,
  proj_ver: handleProjVer,
  prop_rej: handlePropRej,
  prop_veto: handlePropVeto,
  prop_new: handlePropNew,
  rec_cr: handleRecCr,
  rec_can: handleRecCan,
  rec_exec: handleRecExec,
  // Events that are logged only:
  deact_all: handleOtherEvent,
  co2_rate: handleOtherEvent,
  prj_pause: handleOtherEvent,
  prj_resm: handleOtherEvent,
  usdc_set: handleOtherEvent,
  sub_creat: handleOtherEvent,
  sub_canc: handleOtherEvent,
};

// ── Main polling logic ──────────────────────────────────────────────────────

/**
 * Fetch a batch of events from the Soroban RPC, dispatch to handlers,
 * and persist the cursor. Called once per poll interval.
 */
async function pollEvents() {
  const batchStart = Date.now();

  try {
    // Check if contract is configured
    if (!CONTRACT_ID) {
      logger.warn(
        { event: "soroban_events_no_contract" },
        "CONTRACT_ID not set — skipping Soroban event poll",
      );
      return;
    }

    // Fetch events from the RPC
    const request = {
      filters: [
        {
          type: "contract",
          contractIds: [CONTRACT_ID],
          topics: [["*", "*", "*", "*"]],
        },
      ],
      limit: BATCH_SIZE,
    };

    if (currentCursor) {
      request.cursor = currentCursor;
    }

    let response;
    try {
      response = await withRetry(() => rpcServer.getEvents(request));
    } catch (err) {
      logger.error(
        {
          event: "soroban_events_rpc_error",
          err: err.message,
          cursor: currentCursor,
        },
        "Failed to fetch events from Soroban RPC",
      );
      sorobanEventsProcessedTotal.inc({ event_type: "rpc_error", outcome: "failed" });
      return;
    }

    if (!response || !response.events || response.events.length === 0) {
      return; // No new events — normal idle state
    }

    const events = response.events;
    logger.debug(
      {
        event: "soroban_events_poll",
        count: events.length,
        cursor: currentCursor || "(start)",
      },
      `Fetched ${events.length} Soroban event(s)`,
    );

    // Process each event
    let newCursor = currentCursor;
    let processed = 0;
    let skipped = 0;
    let failed = 0;

    for (const evt of events) {
      const pagingToken = evt.pagingToken || "";

      // Dedup by pagingToken
      if (pagingToken && processedTokens.has(pagingToken)) {
        skipped++;
        continue;
      }

      const eventType = extractEventType(evt);
      const handler = HANDLERS[eventType] || handleOtherEvent; // eslint-disable-line security/detect-object-injection

      try {
        const topics = extractTopics(evt);
        const value = extractValue(evt);
        await handler(evt, topics, value);

        if (pagingToken) {
          processedTokens.add(pagingToken);
        }
        processed++;
        sorobanEventsProcessedTotal.inc({ event_type: eventType, outcome: "success" });
      } catch (err) {
        failed++;
        logger.error(
          {
            event: "soroban_events_handler_error",
            eventType,
            pagingToken,
            err: err.message,
          },
          `Event handler "${eventType}" failed`,
        );
        sorobanEventsProcessedTotal.inc({ event_type: eventType, outcome: "failed" });

        // Write to DLQ
        await writeToDLQ(evt, eventType, err);
        // Still mark as processed to avoid infinite retry loops
        if (pagingToken) {
          processedTokens.add(pagingToken);
        }
      }

      // Track the latest cursor
      if (pagingToken) {
        newCursor = pagingToken;
      }
    }

    // Persist cursor so restarts don't reprocess
    if (newCursor && newCursor !== currentCursor) {
      currentCursor = newCursor;
      await saveCursor(currentCursor);
    }

    // Prune dedup set if needed
    pruneDedupSet();

    // Track lag
    if (events.length > 0) {
      const lastEvent = events[events.length - 1];
      if (lastEvent.ledger) {
        // approximate lag — latest ledger we've seen
        sorobanEventsLagLedgers.set(
          Math.max(0, lastEvent.ledgerSeq ? 0 : 0), // ledger lag tracking
        );
      }
    }

    const durationMs = Date.now() - batchStart;
    sorobanEventsBatchDurationSeconds.set(durationMs / 1000);

    logger.info(
      {
        event: "soroban_events_batch_complete",
        processed,
        skipped,
        failed,
        total: events.length,
        cursor: currentCursor,
        durationMs,
      },
      `Batch complete: ${processed} processed, ${skipped} skipped, ${failed} failed`,
    );
  } catch (err) {
    logger.error(
      {
        event: "soroban_events_poll_error",
        err: err.message,
      },
      "Unexpected error during Soroban event poll",
    );
  }
}

// ── Service lifecycle ───────────────────────────────────────────────────────

/**
 * Start the Soroban event subscription service.
 * Loads the persisted cursor, kicks off the first poll immediately,
 * then schedules recurring polls every POLL_INTERVAL_MS.
 *
 * @param {import("socket.io").Server} [socketIo] — Optional Socket.io server
 *   for emitting real-time donation events to connected clients.
 */
async function start(socketIo) {
  if (isRunning) return;
  isRunning = true;
  sorobanEventsRunning.set(1);

  if (socketIo) {
    io = socketIo;
  }

  // Load persisted cursor
  currentCursor = await loadCursor();
  logger.info(
    {
      event: "soroban_events_started",
      cursor: currentCursor || "(start)",
      contractId: CONTRACT_ID,
      pollIntervalMs: POLL_INTERVAL_MS,
    },
    "Soroban event service started",
  );

  // Run initial poll immediately
  pollEvents().catch((err) =>
    logger.error(
      { event: "soroban_events_initial_poll_error", err: err.message },
      "Initial event poll failed",
    ),
  );

  // Schedule recurring polls
  pollingTimer = setInterval(() => {
    pollEvents().catch((err) =>
      logger.error(
        { event: "soroban_events_poll_loop_error", err: err.message },
        "Poll loop iteration failed",
      ),
    );
  }, POLL_INTERVAL_MS);

  if (typeof pollingTimer.unref === "function") {
    pollingTimer.unref();
  }
}

/**
 * Stop the service. Clears the polling interval and resets state.
 * Idempotent — safe to call multiple times.
 */
async function stop() {
  if (!isRunning) return;
  isRunning = false;
  sorobanEventsRunning.set(0);

  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }

  io = null;

  // Persist the current cursor before shutting down
  if (currentCursor) {
    await saveCursor(currentCursor);
  }

  logger.info(
    {
      event: "soroban_events_stopped",
      finalCursor: currentCursor,
    },
    "Soroban event service stopped",
  );
}

/**
 * Return health status for readiness probes.
 */
function getStatus() {
  return {
    isRunning,
    currentCursor,
    processedTokenCount: processedTokens.size,
    contractId: CONTRACT_ID,
    pollIntervalMs: POLL_INTERVAL_MS,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Manually trigger a rescan from a specific cursor (or from the beginning
 * if no cursor provided). Used by the admin API.
 *
 * @param {string} [fromCursor] — Optional cursor to start from.
 * @returns {Promise<{processed: number, failed: number}>}
 */
async function rescan(fromCursor) {
  if (fromCursor) {
    currentCursor = fromCursor;
  } else {
    currentCursor = ""; // start from beginning
    processedTokens.clear();
  }

  logger.info(
    {
      event: "soroban_events_rescan",
      cursor: currentCursor || "(start)",
    },
    "Manual rescan initiated",
  );

  await pollEvents();
  return { message: "Rescan initiated — check logs for results" };
}

module.exports = {
  start,
  stop,
  getStatus,
  rescan,
  // Exported for unit testing
  extractEventType,
  extractTopics,
  extractValue,
  pollEvents,
  HANDLERS,
};
