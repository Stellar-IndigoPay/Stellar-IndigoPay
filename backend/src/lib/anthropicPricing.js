"use strict";

/**
 * lib/anthropicPricing.js
 *
 * Static USD pricing table for Anthropic models, used to convert the
 * `usage` object returned by services/claude.js's generateProjectSummary()
 * into an estimated dollar cost for the ai_summary_cost_usd_total metric
 * (see services/metrics.js — that metric's doc comment references this
 * file, which is why it was never actually populated: the file didn't
 * exist yet).
 *
 * *** PLACEHOLDER PRICING — VERIFY BEFORE MERGING ***
 * The numbers below are illustrative and have NOT been verified against
 * Anthropic's current published pricing. Check
 * https://www.anthropic.com/pricing (or your Anthropic Console billing
 * page) for the actual current per-model rate before relying on the cost
 * metric this produces, and update PRICING_PER_MILLION_TOKENS_USD
 * whenever the model pinned in services/claude.js (SUMMARY_MODEL) changes
 * or Anthropic revises pricing. A stale rate here doesn't fail loudly —
 * it just quietly under- or over-reports cost.
 *
 * All rates are USD per 1,000,000 tokens. cacheWrite is the ephemeral
 * cache-write rate; cacheRead is the cache-hit read rate — both only
 * apply when a call actually uses prompt caching (see the
 * `cache_control: ephemeral` block in claude.js).
 */

const PRICING_PER_MILLION_TOKENS_USD = {
  "claude-opus-4-7": {
    input: 15,
    output: 75,
    cacheWrite: 18.75,
    cacheRead: 1.5,
  },
};

// Used when a model isn't in the table above (e.g. CLAUDE_SUMMARY_MODEL is
// overridden to a model not yet priced here). We deliberately don't throw —
// a missing price shouldn't break summary generation, only the accuracy of
// its cost tracking for that one call. `priced: false` in the return value
// tells the caller the fallback rate was used, so it can be logged/flagged
// rather than silently trusted as exact.
const DEFAULT_PRICING = PRICING_PER_MILLION_TOKENS_USD["claude-opus-4-7"];

/**
 * Estimate the USD cost of one Anthropic API call from its `usage` object.
 *
 * @param {string} model - the `model` string returned in the API response
 * @param {{
 *   input_tokens?: number,
 *   output_tokens?: number,
 *   cache_creation_input_tokens?: number,
 *   cache_read_input_tokens?: number
 * } | undefined} usage - the `usage` object returned by the Anthropic SDK
 * @returns {{ costUsd: number, priced: boolean }} `priced` is false when
 *   `model` wasn't found in the pricing table and the fallback rate was
 *   used instead.
 */
function calculateCostUsd(model, usage) {
  const pricing = PRICING_PER_MILLION_TOKENS_USD[model];
  const rates = pricing || DEFAULT_PRICING;

  if (!usage) {
    return { costUsd: 0, priced: Boolean(pricing) };
  }

  const inputTokens = usage.input_tokens || 0;
  const outputTokens = usage.output_tokens || 0;
  const cacheWriteTokens = usage.cache_creation_input_tokens || 0;
  const cacheReadTokens = usage.cache_read_input_tokens || 0;

  const costUsd =
    (inputTokens / 1_000_000) * rates.input +
    (outputTokens / 1_000_000) * rates.output +
    (cacheWriteTokens / 1_000_000) * rates.cacheWrite +
    (cacheReadTokens / 1_000_000) * rates.cacheRead;

  return { costUsd, priced: Boolean(pricing) };
}

module.exports = { calculateCostUsd, PRICING_PER_MILLION_TOKENS_USD };