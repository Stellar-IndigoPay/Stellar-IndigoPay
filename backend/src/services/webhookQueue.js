"use strict";

/**
 * src/services/webhookQueue.js
 *
 * pg-boss-backed webhook delivery. The route handler that observes a
 * milestone reaches `enqueueWebhookDelivery()` and returns immediately;
 * this worker does the signed POST, retries with exponential backoff,
 * and finally writes terminal failures to `webhook_dlq`.
 *
 * Wire format (kept stable for partners):
 *   - X-Webhook-Id:        event_id (sha256 of canonical milestone fields)
 *   - X-Webhook-Timestamp: unix seconds at sign time
 *   - X-Webhook-Signature: t=<ts>,v1=<hex hmac-sha256(secret, `${ts}.body`)>
 *   - X-Webhook-Event-Type: e.g. "milestone.reached"
 *   - X-Webhook-Attempt:   1-based attempt number
 *   - X-Webhook-Delivery-Id: uuid of the webhook_deliveries row
 *
 * Retry policy: 30s, 2m, 10m, 30m, 2h, 6h (6 attempts) before DLQ.
 */

const crypto = require("crypto");
const https = require("https");
const http = require("http");
const { URL } = require("url");
const PgBoss = require("pg-boss");

const pool = require("../db/pool");
const logger = require("../logger");
const { metrics } = require("./metrics");
const {
  computeEventId,
  sign,
  DEFAULT_REPLAY_WINDOW_SECONDS,
} = require("../lib/webhookSign");

const QUEUE = "webhook-deliveries";
const RETRY_DELAYS_SECONDS = [30, 120, 600, 1800, 7200, 21600]; // 6 attempts
const TIMEOUT_MS = 10_000;
const USER_AGENT = "Stellar-IndigoPay-Webhook/1.0";

let boss = null;

/**
 * Start the worker. Idempotent — safe to call more than once.
 * Must be called AFTER migrations run and BEFORE the HTTP server accepts traffic.
 */
async function start() {
  if (boss) return;
  const connectionString =
    process.env.DATABASE_URL ||
    "postgres://postgres:postgres@localhost:5432/indigopay";
  boss = new PgBoss(connectionString);
  boss.on("error", (err) =>
    logger.error(
      { event: "webhook_queue_error", err: err.message },
      "pg-boss error",
    ),
  );
  await boss.start();

  await boss.work(
    QUEUE,
    {
      teamSize: 2,
      teamConcurrency: 1,
      retryLimit: RETRY_DELAYS_SECONDS.length,
    },
    async (job) => {
      const { deliveryId } = job.data || {};
      if (!deliveryId) {
        // Defensive: malformed job. Don't retry.
        logger.error(
          { event: "webhook_delivery_malformed", jobId: job.id },
          "missing deliveryId",
        );
        return;
      }
      await processDelivery(deliveryId);
    },
  );

  logger.info(
    { event: "webhook_queue_started", queue: QUEUE },
    "webhook queue worker registered",
  );
}

/**
 * Enqueue a webhook delivery. Returns the event_id (sha256) which is
 * also the unique key in webhook_deliveries — repeat enqueues with the
 * same canonical fields will collide on the UNIQUE constraint and the
 * caller can treat that as "already scheduled".
 */
async function enqueueWebhookDelivery({
  projectId,
  eventType,
  payload,
  secret,
}) {
  const eventId = computeEventId({
    projectId,
    milestoneId: payload.milestoneId ?? null,
    percentage: payload.percentage ?? 0,
    raisedXlm: payload.totalRaisedXLM ?? payload.raisedXlm ?? "0",
  });

  const tentativeId = crypto.randomUUID();
  let deliveryId;
  let wasInserted = true;
  try {
    // Use ON CONFLICT ... DO UPDATE ... RETURNING to atomically claim a row id
    // and discover whether we created it or matched an existing one. The
    // xmax = 0 trick distinguishes a freshly-inserted tuple from one that
    // was already present (xmax != 0 in that case).
    const result = await pool.query(
      `INSERT INTO webhook_deliveries
         (id, project_id, event_id, event_type, payload, status, next_attempt_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, 'pending', NOW())
       ON CONFLICT (event_id) DO UPDATE
         SET updated_at = NOW()
       RETURNING id, (xmax = 0) AS inserted`,
      [tentativeId, projectId, eventId, eventType, JSON.stringify(payload)],
    );
    deliveryId = result.rows[0].id;
    wasInserted = result.rows[0].inserted;
  } catch (err) {
    logger.error(
      {
        event: "webhook_enqueue_db_error",
        err: err.message,
        projectId,
        eventId,
      },
      "failed to record delivery row",
    );
    throw err;
  }

  if (!boss) {
    // During tests / one-off scripts: skip the queue and process inline.
    // Retries are unavailable in this mode; the row sits at status=pending
    // and a future enqueueWebhookDelivery for the same event_id will pick
    // it up via the ON CONFLICT branch above.
    await processDelivery(deliveryId, {
      eventId,
      projectId,
      eventType,
      payload,
      secret,
    });
    return eventId;
  }

  // Schedule a single-attempt pg-boss job. We control retries ourselves
  // (see processDelivery) so the worker doesn't auto-retry on throw —
  // instead, on failure we reschedule a new job with `startAfter` set to
  // the appropriate backoff.
  await boss.send(QUEUE, { deliveryId, secret }, { retryLimit: 0 });

  if (!wasInserted) {
    logger.info(
      { event: "webhook_dedupe_hit", eventId, deliveryId },
      "duplicate webhook enqueue collapsed to existing delivery",
    );
  }
  return eventId;
}

/**
 * Load the delivery row, sign + POST it, record outcome.
 * Exposed for the in-memory path used when pg-boss isn't started.
 */
async function processDelivery(deliveryId, inMemoryOverrides) {
  const { rows } = await pool.query(
    `SELECT d.id, d.project_id, d.event_id, d.event_type, d.payload, d.attempts,
            p.webhook_url, p.webhook_secret
       FROM webhook_deliveries d
       JOIN projects p ON p.id = d.project_id
      WHERE d.id = $1`,
    [deliveryId],
  );
  const row = rows[0];
  if (!row) {
    logger.warn(
      { event: "webhook_delivery_missing", deliveryId },
      "delivery row vanished",
    );
    return;
  }
  if (row.status === "delivered") {
    return; // idempotent skip
  }

  const secret =
    (inMemoryOverrides && inMemoryOverrides.secret) || row.webhook_secret;
  const url = row.webhook_url;
  if (!url || !secret) {
    await markTerminal(
      deliveryId,
      "failed",
      "missing webhook_url or webhook_secret",
    );
    metrics.webhookDeliveriesTotal.inc({ outcome: "skipped" });
    return;
  }

  const body = JSON.stringify({
    id: row.event_id,
    type: row.event_type,
    ...row.payload,
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = sign(body, secret, timestamp);

  metrics.webhookAttemptsTotal.inc({ event_type: row.event_type });
  const result = await postSigned(url, body, {
    eventId: row.event_id,
    eventType: row.event_type,
    deliveryId,
    timestamp,
    signature,
    attempt: row.attempts + 1,
  });

  if (result.ok) {
    await pool.query(
      `UPDATE webhook_deliveries
          SET status='delivered',
              attempts = attempts + 1,
              last_attempt_at = NOW(),
              last_error = NULL,
              next_attempt_at = NULL,
              updated_at = NOW()
        WHERE id = $1`,
      [deliveryId],
    );
    metrics.webhookDeliveriesTotal.inc({ outcome: "delivered" });
    logger.info(
      {
        event: "webhook_delivered",
        deliveryId,
        projectId: row.project_id,
        status: result.statusCode,
      },
      "Webhook delivered",
    );
    return;
  }

  const nextAttempt = row.attempts + 1;
  const willRetry = nextAttempt < RETRY_DELAYS_SECONDS.length;
  const nextDelay = willRetry ? RETRY_DELAYS_SECONDS[nextAttempt] : 0;
  const nextStatus = willRetry ? "pending" : "dlq";

  await pool.query(
    `UPDATE webhook_deliveries
        SET attempts = attempts + 1,
            last_attempt_at = NOW(),
            last_error = $2,
            status = $3,
            next_attempt_at = $4,
            updated_at = NOW()
      WHERE id = $1`,
    [
      deliveryId,
      result.error,
      nextStatus,
      willRetry ? new Date(Date.now() + nextDelay * 1000) : null,
    ],
  );

  if (!willRetry) {
    await pool.query(
      `INSERT INTO webhook_dlq (id, delivery_id, project_id, event_id, payload, failure_reason, attempts)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
      [
        crypto.randomUUID(),
        deliveryId,
        row.project_id,
        row.event_id,
        JSON.stringify(row.payload),
        result.error,
        nextAttempt,
      ],
    );
    metrics.webhookDeliveriesTotal.inc({ outcome: "dlq" });
  } else {
    metrics.webhookDeliveriesTotal.inc({ outcome: "retry" });
    // Reschedule the next attempt with `startAfter` so the delay is
    // honored even though pg-boss itself isn't doing retries. Without
    // this, the delivery row would sit at status='pending' forever and
    // the advertised 6-attempt backoff would never actually fire.
    if (boss) {
      try {
        await boss.send(
          QUEUE,
          { deliveryId, secret: inMemoryOverrides ? secret : undefined },
          {
            retryLimit: 0,
            startAfter: new Date(Date.now() + nextDelay * 1000),
          },
        );
      } catch (err) {
        logger.error(
          { event: "webhook_reschedule_error", deliveryId, err: err.message },
          "failed to reschedule retry — row left in pending state",
        );
      }
    } else {
      logger.warn(
        { event: "webhook_retry_unavailable", deliveryId },
        "pg-boss not started; cannot reschedule retry, row left in pending state",
      );
    }
  }
  logger.warn(
    {
      event: "webhook_delivery_failed",
      deliveryId,
      attempt: nextAttempt,
      willRetry,
      err: result.error,
      statusCode: result.statusCode,
    },
    "Webhook delivery failed",
  );
}

/**
 * Replay a dead-lettered delivery: resets its attempt counter so it gets
 * the full retry budget again, then immediately attempts redelivery
 * in-process (the admin-facing replay endpoints want a synchronous
 * result rather than waiting on the queue worker).
 *
 * Only rows currently in the 'dlq' state are eligible — replaying a
 * delivery that's still pending/delivered/failed would race the
 * regular retry path.
 *
 * @param {string} deliveryId - webhook_deliveries.id to replay.
 * @returns {Promise<boolean>} true if a dlq row was found and replayed, false otherwise.
 */
async function replayDelivery(deliveryId) {
  const { rows } = await pool.query(
    `UPDATE webhook_deliveries
        SET status = 'pending',
            attempts = 0,
            last_error = NULL,
            next_attempt_at = NOW(),
            updated_at = NOW()
      WHERE id = $1 AND status = 'dlq'
      RETURNING id`,
    [deliveryId],
  );
  if (!rows[0]) return false;

  await processDelivery(deliveryId);
  return true;
}

async function markTerminal(deliveryId, status, error) {
  await pool.query(
    `UPDATE webhook_deliveries
        SET status = $2, last_error = $3, last_attempt_at = NOW(), updated_at = NOW()
      WHERE id = $1`,
    [deliveryId, status, error],
  );
}

function postSigned(urlString, body, headers) {
  return new Promise((resolve) => {
    let urlObj;
    try {
      urlObj = new URL(urlString);
    } catch (err) {
      return resolve({ ok: false, error: `invalid URL: ${err.message}` });
    }
    const lib = urlObj.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === "https:" ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "User-Agent": USER_AGENT,
          "X-Webhook-Id": headers.eventId,
          "X-Webhook-Event-Type": headers.eventType,
          "X-Webhook-Delivery-Id": headers.deliveryId,
          "X-Webhook-Timestamp": String(headers.timestamp),
          "X-Webhook-Signature": headers.signature,
          "X-Webhook-Attempt": String(headers.attempt),
        },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        res.on("data", () => {});
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            return resolve({ ok: true, statusCode: res.statusCode });
          }
          resolve({
            ok: false,
            statusCode: res.statusCode,
            error: `non-2xx: ${res.statusCode}`,
          });
        });
      },
    );
    req.on("error", (err) => resolve({ ok: false, error: err.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, error: "timeout" });
    });
    req.write(body);
    req.end();
  });
}

async function stop() {
  if (!boss) return;
  try {
    await boss.stop({ graceful: true, timeout: 15_000 });
  } catch (err) {
    logger.warn(
      { event: "webhook_queue_stop_error", err: err.message },
      "graceful stop failed",
    );
  }
}

module.exports = {
  QUEUE,
  RETRY_DELAYS_SECONDS,
  start,
  stop,
  enqueueWebhookDelivery,
  processDelivery,
  replayDelivery,
  // Re-export for tests / advanced callers
  sign,
  computeEventId,
  DEFAULT_REPLAY_WINDOW_SECONDS,
};
