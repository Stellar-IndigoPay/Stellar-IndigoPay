"use strict";

/**
 * src/services/pushQueue.js
 *
 * pg-boss-backed push notification delivery. Route handlers (donations,
 * webhook milestones, project updates) call `enqueuePushNotification()`
 * and return immediately; this worker calls into `pushService` to do
 * the actual Expo send, with pg-boss retrying transient failures.
 */

const PgBoss = require("pg-boss");
const logger = require("../logger");
const pool = require("../db/pool");
const pushService = require("./pushService");

const QUEUE = "push-notifications";
let boss = null;

const HANDLERS = {
  async donation_receipt({ donorAddress, projectId, donationId, amount, currency }) {
    const { rows } = await pool.query(
      "SELECT name FROM projects WHERE id = $1",
      [projectId],
    );
    const projectName = rows[0]?.name || "your project";
    await pushService.sendDonationReceipt(donorAddress, {
      amount,
      currency,
      projectId,
      projectName,
      id: donationId,
    });
  },

  async milestone_reached({ projectId, percentage }) {
    const { rows } = await pool.query(
      "SELECT name FROM projects WHERE id = $1",
      [projectId],
    );
    const projectName = rows[0]?.name || "A project you follow";
    await pushService.sendMilestoneReachedNotifications({
      projectId,
      projectName,
      percentage,
    });
  },

  async project_update({ project, update }) {
    await pushService.sendProjectUpdateNotifications({ project, update });
  },

  async governance_proposal({ proposalId, title, description, endsAt }) {
    await pushService.sendGovernanceProposalNotifications({
      proposalId,
      title,
      description,
      endsAt,
    });
  },

  async recurring_reminder({
    donorAddress,
    projectName,
    amount,
    currency,
    projectId,
    nextPaymentDate,
    recurringId,
  }) {
    await pushService.sendRecurringReminder({
      donorAddress,
      projectName,
      amount,
      currency,
      projectId,
      nextPaymentDate,
      recurringId,
    });
  },
};

/**
 * Start the worker. Idempotent — safe to call more than once.
 */
async function start() {
  if (boss) return;
  const connectionString =
    process.env.DATABASE_URL ||
    "postgres://postgres:postgres@localhost:5432/indigopay";
  boss = new PgBoss(connectionString);
  boss.on("error", (err) =>
    logger.error({ event: "push_queue_error", err: err.message }, "pg-boss error"),
  );
  await boss.start();

  await boss.work(QUEUE, { teamSize: 2, teamConcurrency: 1 }, async (job) => {
    const { type, payload } = job.data || {};
    const handler = HANDLERS[type];
    if (!handler) {
      logger.error(
        { event: "push_job_unknown_type", type, jobId: job.id },
        "Unknown push notification job type",
      );
      return;
    }
    await handler(payload || {});
  });

  logger.info(
    { event: "push_queue_started", queue: QUEUE },
    "push queue worker registered",
  );
}

/**
 * Enqueue a push notification job. `type` must be one of the keys in
 * HANDLERS above.
 */
async function enqueuePushNotification({ type, payload }) {
  if (!HANDLERS[type]) {
    throw new Error(`Unknown push notification type: ${type}`);
  }
  if (!boss) {
    throw new Error("pushQueue not started — call start() first");
  }
  return boss.send(QUEUE, { type, payload }, { retryLimit: 3, retryDelay: 10 });
}

async function stop() {
  if (!boss) return;
  try {
    await boss.stop({ graceful: true, timeout: 15_000 });
  } catch (err) {
    logger.warn(
      { event: "push_queue_stop_error", err: err.message },
      "graceful stop failed",
    );
  }
}

module.exports = { QUEUE, start, stop, enqueuePushNotification };
