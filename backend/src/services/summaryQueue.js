/**
 * src/services/summaryQueue.js
 *
 * pg-boss job queue for async AI summary generation.
 * Keeps the HTTP request lifecycle decoupled from the Claude API call.
 *
 * Throttling
 * ----------
 * Two independent guards protect against unbounded LLM cost:
 *
 * 1. Per-project cooldown — enqueueAISummary() atomically claims the right
 *    to (re)generate a project's summary via
 *      UPDATE projects SET ai_summary_generated_at = NOW() WHERE ... AND <cooldown expired>
 *    reusing the existing ai_summary_generated_at column rather than a new
 *    table. If the UPDATE matches no row, the project is still within its
 *    cooldown window and the call is rejected before anything is enqueued.
 *
 *    Trade-off: this stamps ai_summary_generated_at at CLAIM time, not at
 *    successful-completion time. If the job subsequently fails, the
 *    cooldown still holds for the rest of the window even though nothing
 *    was generated. This is deliberate — the risk this issue addresses is
 *    cost from bursts, and a failed job retrying a few minutes later is a
 *    much smaller cost than leaving the door open to another burst.
 *
 * 2. Global concurrency cap — boss.work's teamSize limits how many summary
 *    jobs can be processing at once across the whole system, regardless of
 *    how many are queued. Configurable via AI_SUMMARY_CONCURRENCY.
 */
"use strict";

const crypto = require("crypto");
const PgBoss = require("pg-boss");
const pool = require("../db/pool");
const logger = require("../logger");

const { generateProjectSummary, SUMMARY_MODEL } = require("./claude");

const { generateProjectSummary } = require("./claude");
const { sanitizeSummary } = require("../lib/summarySanitize");

const { logAdminAction } = require("./audit");
const { metrics } = require("./metrics");
const { calculateCostUsd } = require("../lib/anthropicPricing");

const QUEUE = "ai-summary";


// Per-project cooldown: minimum time between summary generations for the
// same project. Overridable via AI_SUMMARY_COOLDOWN_MS for ops tuning.
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

// Global concurrency cap: max summary jobs processing at once, system-wide.
// Overridable via AI_SUMMARY_CONCURRENCY. Was previously a bare `teamSize: 2`
// with no explanation or way to tune it without a code change.
const DEFAULT_CONCURRENCY = 2;

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

function resolveCooldownMs() {
  const parsed = Number.parseInt(process.env.AI_SUMMARY_COOLDOWN_MS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_COOLDOWN_MS;
}

function resolveConcurrency() {
  const parsed = Number.parseInt(process.env.AI_SUMMARY_CONCURRENCY, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CONCURRENCY;
}

/**
 * Record outcome/latency/token/cost metrics for one generateProjectSummary
 * attempt. Called from the job worker below for both success and failure —
 * factored out so the two paths can't drift out of sync with each other.
 */
function recordSummaryMetrics({ outcome, reason, model, latencyMs, usage }) {
  metrics.aiSummaryOutcomesTotal.inc({ outcome, reason });
  metrics.aiSummaryLatencySeconds.observe(
    { model: model || SUMMARY_MODEL, outcome },
    (latencyMs || 0) / 1000,
  );

  if (outcome !== "success" || !usage) return;

  metrics.aiSummaryTokensTotal.inc({ model, direction: "input" }, usage.input_tokens || 0);
  metrics.aiSummaryTokensTotal.inc({ model, direction: "output" }, usage.output_tokens || 0);
  if (usage.cache_creation_input_tokens) {
    metrics.aiSummaryTokensTotal.inc(
      { model, direction: "cache_write" },
      usage.cache_creation_input_tokens,
    );
  }
  if (usage.cache_read_input_tokens) {
    metrics.aiSummaryTokensTotal.inc(
      { model, direction: "cache_read" },
      usage.cache_read_input_tokens,
    );
  }

  const { costUsd, priced } = calculateCostUsd(model, usage);
  metrics.aiSummaryCostUsdTotal.inc({ model }, costUsd);
  if (!priced) {
    logger.warn(
      { event: "ai_summary_unpriced_model", model },
      `[summaryQueue] No pricing entry for model "${model}" — cost metric used the fallback rate`,
    );
  }
}

/**
 * Start the pg-boss scheduler and register the AI-summary worker.
 * Must be called after database migrations and before the HTTP server starts
 * accepting requests.
 *
 * @param {import('socket.io').Server} io  Socket.IO server instance
 */
async function start(io) {
  if (boss) return;

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


  const teamSize = resolveConcurrency();
  await boss.work(QUEUE, { teamSize, teamConcurrency: 1 }, async (job) => {

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
      recordSummaryMetrics({
        outcome: "error",
        reason: err.reason || "provider_error",
        model: SUMMARY_MODEL,
        latencyMs: err.latencyMs,
      });

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

    recordSummaryMetrics({
      outcome: "success",
      reason: "ok",
      model: summaryResult.model,
      latencyMs: summaryResult.latencyMs,
      usage: summaryResult.usage,
    });

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

  logger.info(
    { event: "summary_queue_started", teamSize, cooldownMs: resolveCooldownMs() },
    `[summaryQueue] started (concurrency=${teamSize})`,
  );
}

async function stop() {
  if (!boss) return;
  await boss.stop({ graceful: true, timeout: 15_000 });
  boss = null;
}

/**
 * Enqueue an AI summary generation job for a project, subject to the
 * per-project cooldown.
 *
 * Atomically claims the cooldown window via a conditional UPDATE before
 * enqueueing — see the module doc comment above for why this reuses
 * ai_summary_generated_at rather than a separate claim table, and the
 * trade-off that implies.
 *
 * @param {string} projectId
 * @param {{ name: string, category: string, description: string, adminAddress?: string }} projectData
 * @returns {Promise<string>} job ID
 * @throws {Error & { code: "SUMMARY_COOLDOWN_ACTIVE", retryAfterSeconds?: number }}
 *   if the project generated a summary within the cooldown window
 */
async function enqueueAISummary(projectId, projectData) {
  if (!boss) {
    throw new Error("summaryQueue not started — call start(io) first");
  }

  const cooldownMs = resolveCooldownMs();
  const claim = await pool.query(
    `UPDATE projects
        SET ai_summary_generated_at = NOW()
      WHERE id = $1
        AND (
          ai_summary_generated_at IS NULL
          OR ai_summary_generated_at < NOW() - (INTERVAL '1 millisecond' * $2)
        )
      RETURNING ai_summary_generated_at`,
    [projectId, cooldownMs],
  );

  if (claim.rows.length === 0) {
    // Best-effort lookup purely to give the caller a useful retryAfter —
    // not part of the atomic claim itself, so it's fine if this is
    // slightly stale by the time the caller reads it.
    const current = await pool.query(
      "SELECT ai_summary_generated_at FROM projects WHERE id = $1",
      [projectId],
    );
    const lastGeneratedAt = current.rows[0]?.ai_summary_generated_at;
    const retryAfterSeconds = lastGeneratedAt
      ? Math.max(
          0,
          Math.ceil(
            (new Date(lastGeneratedAt).getTime() + cooldownMs - Date.now()) / 1000,
          ),
        )
      : undefined;

    const err = new Error(
      "AI summary generation is on cooldown for this project",
    );
    err.code = "SUMMARY_COOLDOWN_ACTIVE";
    err.retryAfterSeconds = retryAfterSeconds;
    throw err;
  }

  const jobId = await boss.send(
    QUEUE,
    { projectId, ...projectData },
    { retryLimit: 3, retryDelay: 10 },
  );
  return jobId;
}

module.exports = { start, stop, enqueueAISummary };