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

/**
 * Deterministic, non-AI fallback summary. Used only when the provider is
 * down (retries + circuit breaker exhausted, or a non-retryable error) and
 * the project has no existing summary to fall back to — so the job always
 * produces *something* for the donor-facing UI rather than leaving the
 * field empty indefinitely.
 *
 * @param {{ category: string, description: string }} project
 * @returns {string}
 */
function buildRuleBasedFallbackSummary({ category, description }) {
  const cat = (category || "").trim() || "This project";
  const desc = (description || "").trim();
  const snippet = desc.length > 220 ? `${desc.slice(0, 217).trim()}...` : desc;
  const base = snippet
    ? `${cat} — ${snippet}`
    : `${cat}. A detailed description has not been provided yet.`;
  return sanitizeSummary(`${base} Your donation directly supports this work.`);
}

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

    // Fetched up front so a provider outage has something to fall back to
    // — never overwritten unless generation (or a rule-based degrade)
    // actually produces a new summary below.
    const existingResult = await pool.query(
      "SELECT ai_summary, ai_summary_model FROM projects WHERE id = $1",
      [projectId],
    );
    const existingRow = existingResult.rows[0];
    if (!existingRow) return; // project was deleted while job was queued
    const existingSummary = existingRow.ai_summary || null;

    let summaryResult = null;
    let fallback = null;

    try {
      summaryResult = await generateProjectSummary({
        id: projectId,
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

      // A transient, still-retryable error (a single 429/5xx that hasn't
      // exhausted claude.js's own retry budget yet, or the breaker isn't
      // open) is worth another full job attempt via pg-boss's retryLimit
      // rather than immediately degrading to a possibly-stale fallback.
      if (err.retryable && !err.breakerOpen) {
        throw err;
      }

      // Retries + circuit breaker exhausted, or a non-retryable error
      // (malformed response, breaker open) — degrade instead of failing
      // the job silently.
      if (existingSummary) {
        fallback = {
          summary: existingSummary,
          model: existingRow.ai_summary_model,
          stale: true,
        };
        logger.warn(
          {
            event: "ai_summary_fallback_stale",
            projectId,
            err: err.message,
          },
          "[summaryQueue] Provider unavailable — serving existing summary (stale)",
        );
      } else {
        fallback = {
          summary: buildRuleBasedFallbackSummary({ category, description }),
          model: "fallback-rule-based",
          stale: false,
        };
        logger.warn(
          {
            event: "ai_summary_fallback_rule_based",
            projectId,
            err: err.message,
          },
          "[summaryQueue] Provider unavailable and no cached summary — using rule-based fallback",
        );
      }
    }

    // Stale fallback: the project row already holds this exact summary —
    // nothing to write, just audit that generation was skipped.
    if (fallback && fallback.stale) {
      logAdminAction({
        actor: adminAddress || "system",
        action: "project.summary.fallback_stale",
        targetType: "project",
        targetId: projectId,
        metadata: { model: fallback.model },
        ipAddress: null,
      });
      return;
    }

    const sourceHash = crypto
      .createHash("sha256")
      .update(description || "")
      .digest("hex");

    // Final storage-boundary guard: never persist a summary that still
    // contains markdown/HTML or that sanitizes down to nothing. (The
    // rule-based fallback is already sanitized; re-sanitizing is a no-op.)
    const summaryText = summaryResult ? summaryResult.summary : fallback.summary;
    const summary = sanitizeSummary(summaryText);
    if (!summary) {
      console.error(
        "[summaryQueue] summary empty after sanitization; skipping store",
        projectId,
      );
      return;
    }

    const model = summaryResult ? summaryResult.model : fallback.model;

    const updated = await pool.query(
      `UPDATE projects
          SET ai_summary              = $1,
              ai_summary_generated_at = NOW(),
              ai_summary_model        = $2,
              ai_summary_source_hash  = $3,
              updated_at              = NOW()
        WHERE id = $4
        RETURNING ai_summary, ai_summary_generated_at, ai_summary_model`,
      [summary, model, sourceHash, projectId],
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
        // Only the rule-based path reaches this emit — the stale-fallback
        // path (existing summary already correct) returns earlier above.
        fallback: Boolean(fallback),
      });
    }

    logAdminAction({
      actor: adminAddress || "system",
      action: fallback
        ? "project.summary.fallback_generated"
        : "project.summary.generated",
      targetType: "project",
      targetId: projectId,
      metadata: { model },
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
