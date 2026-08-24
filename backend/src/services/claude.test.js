"use strict";

/**
 * Issue #929: retry/backoff, circuit breaker, and deterministic caching
 * for AI summary generation.
 */

process.env.ANTHROPIC_API_KEY = "test-key";
process.env.CLAUDE_SUMMARY_RETRY_BASE_MS = "1"; // keep backoff fast in tests
process.env.CLAUDE_SUMMARY_MAX_RETRIES = "2";
process.env.CLAUDE_SUMMARY_BREAKER_THRESHOLD = "3";
process.env.CLAUDE_SUMMARY_BREAKER_RESET_MS = "50";

const mockCreate = jest.fn();
jest.mock("@anthropic-ai/sdk", () =>
  jest.fn().mockImplementation(() => ({
    messages: { create: (...args) => mockCreate(...args) },
  })),
);

const mockQuery = jest.fn();
jest.mock("../db/pool", () => ({
  query: (...args) => mockQuery(...args),
}));

function activePromptRow() {
  return { rows: [] }; // no active row => built-in default template
}

function textResponse(text, overrides = {}) {
  return {
    model: "claude-opus-4-7",
    content: [{ type: "text", text }],
    usage: { input_tokens: 100, output_tokens: 50 },
    ...overrides,
  };
}

function apiError(status, message = "provider error") {
  const err = new Error(message);
  err.status = status;
  return err;
}

const PROJECT = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "Reef Restoration",
  category: "ocean",
  description: "Rebuilds coral reefs in Southeast Asia.",
};

/**
 * claude.js keeps circuit breakers in module-level state keyed by model, so
 * each test needs a fully isolated require to avoid one test's failures
 * tripping the breaker for the next.
 */
function loadClaude() {
  let mod;
  jest.isolateModules(() => {
    mod = require("./claude");
  });
  return mod;
}

describe("claude.js — deterministic caching", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("identical inputs return byte-identical output, served from cache on the second call", async () => {
    const claude = loadClaude();

    // 1st call: no active prompt version, cache miss, provider call, then
    // the cache-store INSERT.
    mockQuery
      .mockResolvedValueOnce(activePromptRow()) // getActivePromptTemplate
      .mockResolvedValueOnce({ rows: [] }) // getCachedSummary — miss
      .mockResolvedValueOnce({ rows: [] }); // storeCachedSummary INSERT
    mockCreate.mockResolvedValueOnce(
      textResponse("Sentence one. Sentence two. Sentence three."),
    );

    const first = await claude.generateProjectSummary(PROJECT);
    expect(first.cached).toBe(false);
    expect(mockCreate).toHaveBeenCalledTimes(1);

    // 2nd call, identical inputs: getActivePromptTemplate + getCachedSummary
    // — this time the cache row exists, so no provider call.
    mockQuery
      .mockResolvedValueOnce(activePromptRow())
      .mockResolvedValueOnce({
        rows: [
          {
            summary: first.summary,
            model: first.model,
            template_version: first.templateVersion,
            cost_usd: null,
          },
        ],
      });

    const second = await claude.generateProjectSummary(PROJECT);

    expect(second.cached).toBe(true);
    expect(second.summary).toBe(first.summary);
    expect(second.cacheKey).toBe(first.cacheKey);
    // Still only the one call from before — the cache hit made no provider call.
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  test("a changed input produces a different cache key and a fresh provider call", async () => {
    const claude = loadClaude();

    mockQuery
      .mockResolvedValueOnce(activePromptRow())
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    mockCreate.mockResolvedValueOnce(textResponse("Original summary text."));
    const original = await claude.generateProjectSummary(PROJECT);

    mockQuery
      .mockResolvedValueOnce(activePromptRow())
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    mockCreate.mockResolvedValueOnce(textResponse("Updated summary text."));
    const changed = await claude.generateProjectSummary({
      ...PROJECT,
      description: "A completely different description.",
    });

    expect(changed.cacheKey).not.toBe(original.cacheKey);
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });
});

describe("claude.js — retry, backoff, and circuit breaker", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("retries a 429 then a 5xx before succeeding on the third attempt", async () => {
    const claude = loadClaude();
    mockQuery
      .mockResolvedValueOnce(activePromptRow())
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    mockCreate
      .mockRejectedValueOnce(apiError(429, "rate limited"))
      .mockRejectedValueOnce(apiError(503, "overloaded"))
      .mockResolvedValueOnce(textResponse("Recovered after retries."));

    const result = await claude.generateProjectSummary(PROJECT);

    expect(result.cached).toBe(false);
    expect(result.summary).toBe("Recovered after retries.");
    expect(mockCreate).toHaveBeenCalledTimes(3);
  });

  test("a non-retryable 400 fails immediately without retrying", async () => {
    const claude = loadClaude();
    mockQuery
      .mockResolvedValueOnce(activePromptRow()) // getActivePromptTemplate
      .mockResolvedValueOnce({ rows: [] }); // getCachedSummary — miss
    mockCreate.mockRejectedValueOnce(apiError(400, "bad request"));

    await expect(claude.generateProjectSummary(PROJECT)).rejects.toThrow(
      "bad request",
    );
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  test("the circuit breaker opens after sustained failures and short-circuits further calls", async () => {
    const claude = loadClaude();
    // Threshold is 3 (env override above). Each generateProjectSummary call
    // below exhausts its own retry budget (maxRetries=2 => 3 attempts) on
    // a retryable 503, so 1 call already trips 3 breaker failures.
    mockQuery.mockResolvedValue(activePromptRow());
    mockCreate.mockRejectedValue(apiError(503, "down"));

    await expect(claude.generateProjectSummary(PROJECT)).rejects.toThrow();
    expect(mockCreate).toHaveBeenCalledTimes(3); // 1 + 2 retries

    mockCreate.mockClear();

    // Breaker is now open — the next call must fail fast, without ever
    // reaching the provider.
    await expect(
      claude.generateProjectSummary({ ...PROJECT, id: "22222222-2222-2222-2222-222222222222" }),
    ).rejects.toMatchObject({ breakerOpen: true });
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe("claude.js — helpers", () => {
  test("computeCacheKey changes when template version, model, or input hash changes", () => {
    const claude = loadClaude();
    const base = { templateVersion: "v1", model: "claude-opus-4-7", inputHash: "abc" };
    const key = claude.computeCacheKey(base);

    expect(claude.computeCacheKey({ ...base, templateVersion: "v2" })).not.toBe(key);
    expect(claude.computeCacheKey({ ...base, model: "claude-haiku-4-5" })).not.toBe(key);
    expect(claude.computeCacheKey({ ...base, inputHash: "def" })).not.toBe(key);
    expect(claude.computeCacheKey(base)).toBe(key); // stable for identical input
  });

  test("computeInputHash is stable for identical fields and changes when any field changes", () => {
    const claude = loadClaude();
    const h1 = claude.computeInputHash(PROJECT);
    const h2 = claude.computeInputHash({ ...PROJECT });
    expect(h1).toBe(h2);

    const h3 = claude.computeInputHash({ ...PROJECT, name: "Different Name" });
    expect(h3).not.toBe(h1);
  });

  test("estimateCostUsd returns null for an unknown model rather than guessing", () => {
    const claude = loadClaude();
    expect(
      claude.estimateCostUsd("some-future-model", {
        input_tokens: 100,
        output_tokens: 100,
      }),
    ).toBeNull();
  });
});
