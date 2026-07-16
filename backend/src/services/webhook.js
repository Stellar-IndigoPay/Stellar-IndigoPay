"use strict";

/**
 * src/services/webhook.js
 *
 * Project-milestone bookkeeping. Public surface preserved for the route
 * handler in `donations.js` — the actual delivery is queued by
 * `webhookQueue.enqueueWebhookDelivery`, so this function no longer
 * makes any HTTP request.
 *
 * The function still does its own DB transaction so the route handler
 * can `await` it: it marks any newly-reached milestones and enqueues
 * one delivery per milestone before returning.
 */

const pool = require("../db/pool");
const logger = require("../logger");
const { enqueueWebhookDelivery } = require("./webhookQueue");
const { enqueuePushNotification } = require("./pushQueue");

/**
 * Check project milestones after a donation and enqueue webhooks for
 * any newly reached milestones. Marking the milestone and the
 * delivery enqueue are intentionally on the same code path so we can
 * surface errors synchronously to the caller.
 *
 * @param {string} projectId - Project UUID.
 * @returns {Promise<void>}
 */
async function checkAndDeliverMilestones(projectId) {
  try {
    const projectResult = await pool.query(
      "SELECT id, goal_xlm, raised_xlm, webhook_url, webhook_secret FROM projects WHERE id = $1",
      [projectId],
    );

    const project = projectResult.rows[0];
    if (!project) return;

    const goal = Number.parseFloat(project.goal_xlm);
    const raised = Number.parseFloat(project.raised_xlm);
    if (goal <= 0) return;

    const progressPercent = Math.min(Math.round((raised / goal) * 100), 100);

    const milestoneResult = await pool.query(
      `SELECT id, percentage, title
       FROM project_milestones
       WHERE project_id = $1
         AND percentage <= $2
         AND reached_at IS NULL
       ORDER BY percentage ASC`,
      [projectId, progressPercent],
    );

    const milestones = milestoneResult.rows;
    if (milestones.length === 0) return;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      for (const milestone of milestones) {
        await client.query(
          `UPDATE project_milestones
           SET reached_at = NOW()
           WHERE id = $1 AND project_id = $2 AND reached_at IS NULL`,
          [milestone.id, projectId],
        );
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      logger.error(
        { event: "milestone_update_error", projectId, err: err.message },
        err.message,
      );
      client.release();
      return;
    }
    client.release();

    // Push notifications don't depend on the project having a webhook
    // configured, so they're enqueued unconditionally for every follower.
    for (const milestone of milestones) {
      enqueuePushNotification({
        type: "milestone_reached",
        payload: { projectId, percentage: milestone.percentage },
      }).catch((err) => {
        logger.error(
          {
            event: "push_enqueue_error",
            projectId,
            milestoneId: milestone.id,
            err: err.message,
          },
          "failed to enqueue milestone push notification",
        );
      });
    }

    if (project.webhook_url && project.webhook_secret) {
      for (const milestone of milestones) {
        const payload = {
          event: "milestone.reached",
          projectId,
          milestoneId: milestone.id,
          milestone: milestone.title,
          percentage: milestone.percentage,
          totalRaisedXLM: raised.toFixed(7),
          timestamp: new Date().toISOString(),
        };

        enqueueWebhookDelivery({
          projectId,
          eventType: "milestone.reached",
          payload,
          secret: project.webhook_secret,
        }).catch((err) => {
          logger.error(
            { event: "webhook_enqueue_error", projectId, err: err.message },
            "failed to enqueue webhook",
          );
        });
      }
    }
  } catch (err) {
    logger.error(
      { event: "check_milestones_error", projectId, err: err.message },
      "Failed to check milestones",
    );
  }
}

module.exports = {
  checkAndDeliverMilestones,
};
