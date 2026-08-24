"use strict";

const PgBoss = require("pg-boss");
const pool = require("../db/pool");
const logger = require("../logger");
const { buildDigests } = require("./digestBuilder");
const { sendDigestEmail } = require("./email");
const { createDrainController } = require("./workerLifecycle");

const DRAIN_TIMEOUT_MS = 15_000;
const drain = createDrainController("digest_dispatcher", {
  gracePeriodMs: DRAIN_TIMEOUT_MS,
});

const APP_URL = process.env.APP_URL || "http://localhost:3000";
const DEFAULT_CRONS = {
  daily: "0 8 * * *",
  weekly: "0 9 * * MON",
};
const CRON_ENV = {
  daily: "DAILY_DIGEST_CRON",
  weekly: "WEEKLY_DIGEST_CRON",
};
const QUEUE_NAMES = {
  daily: "digest-daily",
  weekly: "digest-weekly",
};

// Shared retry policy for digest jobs — applied to both the cron-scheduled
// path (boss.schedule) and the manual-trigger path (boss.send) so a job
// that keeps failing (bad Resend config, DB outage) backs off and gives up
// rather than hammering the same window indefinitely. This is separate
// from, and complementary to, the per-recipient dedup below: this caps how
// many times pg-boss retries the *job as a whole*; the dedup guard is what
// stops a retried (or independently duplicated) job from re-emailing
// recipients who already got their digest on an earlier attempt.
const DIGEST_JOB_OPTIONS = {
  retryLimit: 5,
  retryDelay: 30, // seconds, before backoff multiplies it
  retryBackoff: true,
};

// Per-recipient send-claim policy (see digest_sends table, migration
// 028_digest_sends). A 'failed' claim may be re-attempted up to this many
// times; a 'sending' claim stuck longer than the staleness window is
// assumed to belong to a crashed worker and may also be re-claimed.
const MAX_SEND_ATTEMPTS = 5;
const STALE_CLAIM_MS = 15 * 60 * 1000; // 15 minutes

let boss = null;

function getQueueName(type) {
  if (!QUEUE_NAMES[type]) {
    throw new Error(`Unknown digest type: ${type}`);
  }
  return QUEUE_NAMES[type];
}

/**
 * Attempt to claim the right to send `type`'s digest to `donorAddress` for
 * `periodStart`. Returns `{ claimed: true, id, attempts }` if this call won
 * the claim (either a fresh row, or a re-claimed 'failed'/stale-'sending'
 * row) — the caller should proceed to send and then call markDigestSent or
 * markDigestFailed with `id`. Returns `{ claimed: false }` if the
 * recipient+period was already sent, or is currently being sent by another
 * invocation, or has exhausted its retry budget — the caller must not send
 * in that case.
 */
async function claimDigestSend({ type, donorAddress, periodStart }) {
  const insertResult = await pool.query(
    `INSERT INTO digest_sends (digest_type, donor_address, period_start, status, attempts)
     VALUES ($1, $2, $3, 'sending', 1)
     ON CONFLICT (digest_type, donor_address, period_start) DO NOTHING
     RETURNING id, attempts`,
    [type, donorAddress, periodStart],
  );

  if (insertResult.rows[0]) {
    return {
      claimed: true,
      id: insertResult.rows[0].id,
      attempts: insertResult.rows[0].attempts,
    };
  }

  // Someone already holds (or held) this recipient+period. Only re-claim
  // if the previous attempt failed and hasn't exhausted its retry budget,
  // or if a prior claim has sat in 'sending' past the staleness window
  // (worker crashed before recording an outcome).
  const retryResult = await pool.query(
    `UPDATE digest_sends
     SET status = 'sending', attempts = attempts + 1, claimed_at = NOW()
     WHERE digest_type = $1 AND donor_address = $2 AND period_start = $3
       AND (
         (status = 'failed' AND attempts < $4)
         OR (status = 'sending' AND claimed_at < NOW() - (INTERVAL '1 millisecond' * $5))
       )
     RETURNING id, attempts`,
    [type, donorAddress, periodStart, MAX_SEND_ATTEMPTS, STALE_CLAIM_MS],
  );

  if (retryResult.rows[0]) {
    return {
      claimed: true,
      id: retryResult.rows[0].id,
      attempts: retryResult.rows[0].attempts,
    };
  }

  return { claimed: false };
}

async function markDigestSent(claimId) {
  await pool.query(
    "UPDATE digest_sends SET status = 'sent', sent_at = NOW() WHERE id = $1",
    [claimId],
  );
}

async function markDigestFailed(claimId, errorMessage) {
  await pool.query(
    "UPDATE digest_sends SET status = 'failed', last_error = $2 WHERE id = $1",
    [claimId, errorMessage],
  );
}

async function runDigest(type) {
  if (!QUEUE_NAMES[type]) {
    throw new Error(`Unsupported digest type: ${type}`);
  }

  logger.info(
    { event: "digest_run_start", digestType: type },
    `[digestQueue] Starting ${type} digest run`,
  );

  const { label, periodStart, digests } = await buildDigests(type);

  let sent = 0;
  let skipped = 0;
  let errors = 0;

  for (const digest of digests) {
    const claim = await claimDigestSend({
      type,
      donorAddress: digest.donorAddress,
      periodStart,
    });

    if (!claim.claimed) {
      skipped += 1;
      logger.info(
        {
          event: "digest_email_skipped_duplicate",
          digestType: type,
          email: digest.email,
        },
        "[digestQueue] Skipping digest — already sent (or in flight) for this recipient+period",
      );
      continue;
    }

    try {
      await sendDigestEmail({
        to: digest.email,
        digest,
        dashboardUrl: `${APP_URL}/dashboard`,
        unsubscribeUrl: `${APP_URL}/api/notifications/unsubscribe?token=${digest.unsubscribeToken}`,
        subject: `${label} — Your impact summary`,
      });
      await markDigestSent(claim.id);
      sent += 1;
      logger.info(
        {
          event: "digest_email_sent",
          digestType: type,
          email: digest.email,
        },
        "[digestQueue] Digest email sent",
      );
    } catch (err) {
      errors += 1;
      await markDigestFailed(claim.id, err.message);
      logger.error(
        {
          event: "digest_email_failed",
          digestType: type,
          email: digest.email,
          err: err.message,
        },
        "[digestQueue] Digest email failed",
      );
    }
  }

  logger.info(
    { event: "digest_run_complete", digestType: type, sent, skipped, errors, label },
    `[digestQueue] ${type} digest run complete`,
  );
}

async function start() {
  if (boss) return;

  const connectionString =
    process.env.DATABASE_URL ||
    "postgres://postgres:postgres@localhost:5432/indigopay";

  boss = new PgBoss(connectionString);
  boss.on("error", (err) =>
    logger.error({ event: "digest_pgboss_error", err: err.message }, err.message),
  );

  await boss.start();

  for (const type of Object.keys(QUEUE_NAMES)) {
    const cronOverride = process.env[CRON_ENV[type]];
    if (cronOverride === "disabled") {
      logger.info(
        { event: "digest_disabled", digestType: type },
        `[digestQueue] ${type} digest disabled via env`,
      );
      continue;
    }

    const cronSchedule = cronOverride || DEFAULT_CRONS[type];
    const queueName = getQueueName(type);


    await boss.schedule(
      queueName,
      cronSchedule,
      {},
      { tz: "UTC", ...DIGEST_JOB_OPTIONS },
    );

    await boss.createQueue(queueName);
    await boss.schedule(queueName, cronSchedule, {}, { tz: "UTC" });

    await boss.work(
      queueName,
      { teamSize: 1, teamConcurrency: 1 },
      async () =>
        drain.trackJob(async () => {
          try {
            await runDigest(type);
          } catch (err) {
            logger.error(
              {
                event: "digest_worker_error",
                digestType: type,
                err: err.message,
              },
              `[digestQueue] ${type} digest worker failed`,
            );
            throw err;
          }
        }),
    );

    logger.info(
      { event: "digest_scheduled", digestType: type, cron: cronSchedule },
      `[digestQueue] ${type} digest scheduled: ${cronSchedule}`,
    );
  }
}

async function enqueueDigest(type) {
  if (!QUEUE_NAMES[type]) {
    throw new Error(`Unsupported digest type: ${type}`);
  }

  if (!boss) {
    // No pg-boss instance running in this process — run inline. NOTE: this
    // bypasses the queue's own retry/dedup machinery entirely, which is
    // exactly why the per-recipient claim in runDigest()/claimDigestSend()
    // must be enforced at the DB layer rather than only at the queue
    // layer — it's the only guard that still applies on this path.
    return runDigest(type);
  }

  const queueName = getQueueName(type);
  return boss.send(queueName, { type }, DIGEST_JOB_OPTIONS);
}

async function stop() {
  if (!boss) return;
  // pg-boss's own `graceful: true` stop already stops claiming new jobs
  // and waits (up to `timeout`) for active handlers to finish; we mark
  // the drain state around it so the `worker_draining` metric and
  // `getWorkerDrainStates()` reflect reality for the same window.
  const bossStop = boss.stop({ graceful: true, timeout: DRAIN_TIMEOUT_MS });
  await Promise.all([bossStop, drain.beginDrain()]);
  boss = null;
}

module.exports = {
  start,
  stop,
  runDigest,
  enqueueDigest,
  claimDigestSend,
  markDigestSent,
  markDigestFailed,
  // Test-only: introspect drain state without a real SIGTERM.
  _drain: drain,
};