"use strict";

const PgBoss = require("pg-boss");
const logger = require("../logger");
const { buildDigests } = require("./digestBuilder");
const { sendDigestEmail } = require("./email");

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

let boss = null;

function getQueueName(type) {
  if (!QUEUE_NAMES[type]) {
    throw new Error(`Unknown digest type: ${type}`);
  }
  return QUEUE_NAMES[type];
}

async function runDigest(type) {
  if (!QUEUE_NAMES[type]) {
    throw new Error(`Unsupported digest type: ${type}`);
  }

  logger.info(
    { event: "digest_run_start", digestType: type },
    `[digestQueue] Starting ${type} digest run`,
  );

  const { label, digests } = await buildDigests(type);

  let sent = 0;
  let errors = 0;

  for (const digest of digests) {
    try {
      await sendDigestEmail({
        to: digest.email,
        digest,
        dashboardUrl: `${APP_URL}/dashboard`,
        unsubscribeUrl: `${APP_URL}/api/notifications/unsubscribe?token=${digest.unsubscribeToken}`,
        subject: `${label} — Your impact summary`,
      });
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
    { event: "digest_run_complete", digestType: type, sent, errors, label },
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

    await boss.schedule(queueName, cronSchedule, {}, { tz: "UTC" });
    await boss.work(
      queueName,
      { teamSize: 1, teamConcurrency: 1 },
      async () => {
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
      },
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
    return runDigest(type);
  }

  const queueName = getQueueName(type);
  return boss.send(queueName, { type }, { retryLimit: 3, retryDelay: 10 });
}

async function stop() {
  if (!boss) return;
  await boss.stop({ graceful: true, timeout: 15_000 });
}

module.exports = { start, runDigest, enqueueDigest };
