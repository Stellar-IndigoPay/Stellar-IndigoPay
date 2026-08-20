/**
 * src/services/summaryQueue.js
 *
 * pg-boss job queue for async AI summary generation.
 * Keeps the HTTP request lifecycle decoupled from the Claude API call.
 */
"use strict";

const crypto = require("crypto");
const PgBoss = require("pg-boss");
const pool = require("../db/pool");
const logger = require("../logger");
const { generateProjectSummary } = require("./claude");
const { sanitizeSummary } = require("../lib/summarySanitize");
const { logAdminAction } = require("./audit");

const QUEUE = "ai-summary";

let boss = null;

/**
 * Start the pg-boss scheduler and register the AI-summary worker.
 * Must be called after database migrations and before the HTTP server starts
 * accepting requests.
 *
 * @param {import('socket.io').Server} io  Socket.IO server instance
 */
async function start(io) {
  const connectionString =
    process.env.DATABASE_URL ||
    "postgres://postgres:postgres@localhost:5432/indigopay";

  boss = new PgBoss(connectionString);

  boss.on("error", (err) =>
    logger.error(
      { event: "summary_queue_error", err: err.message },
      "Summary queue pg-boss error",
    ),
  );

  await boss.start();
  await boss.createQueue(QUEUE);

  await boss.work(QUEUE, { teamSize: 2, teamConcurrency: 1 }, async ([job]) => {
    const { projectId, name, category, description, adminAddress } = job.data;

    let summaryResult;
    try {
      summaryResult = await generateProjectSummary({
        name,
        category,
        description,
      });
    } catch (err) {
      if (err.code === "MISSING_API_KEY") {
        // Permanent misconfiguration — log and give up without retrying.
        console.error(
          "[summaryQueue] ANTHROPIC_API_KEY not set; skipping job",
          projectId,
        );
        return;
      }
      throw err; // pg-boss will retry according to retryLimit
    }

    const sourceHash = crypto
      .createHash("sha256")
      .update(description || "")
      .digest("hex");

    // Final storage-boundary guard: never persist a summary that still
    // contains markdown/HTML or that sanitizes down to nothing.
    const summary = sanitizeSummary(summaryResult.summary);
    if (!summary) {
      console.error(
        "[summaryQueue] summary empty after sanitization; skipping store",
        projectId,
      );
      return;
    }

    const updated = await pool.query(
      `UPDATE projects
          SET ai_summary              = $1,
              ai_summary_generated_at = NOW(),
              ai_summary_model        = $2,
              ai_summary_source_hash  = $3,
              updated_at              = NOW()
        WHERE id = $4
        RETURNING ai_summary, ai_summary_generated_at, ai_summary_model`,
      [summary, summaryResult.model, sourceHash, projectId],
    );

    const row = updated.rows[0];
    if (!row) return; // project was deleted while job was queued

    if (io) {
      io.emit("ai_summary_ready", {
        projectId,
        aiSummary: row.ai_summary,
        aiSummaryGeneratedAt: new Date(
          row.ai_summary_generated_at,
        ).toISOString(),
        aiSummaryModel: row.ai_summary_model,
      });
    }

    logAdminAction({
      actor: adminAddress || "system",
      action: "project.summary.generated",
      targetType: "project",
      targetId: projectId,
      metadata: { model: summaryResult.model },
      ipAddress: null,
    });
  });
}

async function stop() {
  if (!boss) return;
  await boss.stop({ graceful: true, timeout: 15_000 });
  boss = null;
}

/**
 * Enqueue an AI summary generation job.
 *
 * @param {string} projectId
 * @param {{ name: string, category: string, description: string, adminAddress?: string }} projectData
 * @returns {Promise<string>} job ID
 */
async function enqueueAISummary(projectId, projectData) {
  if (!boss) {
    throw new Error("summaryQueue not started — call start(io) first");
  }
  const jobId = await boss.send(
    QUEUE,
    { projectId, ...projectData },
    { retryLimit: 3, retryDelay: 10 },
  );
  return jobId;
}

module.exports = { start, stop, enqueueAISummary };
