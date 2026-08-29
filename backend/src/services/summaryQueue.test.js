"use strict";

 
jest.mock("pg-boss", () =>
  jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    start: jest.fn().mockResolvedValue(undefined),
    work: jest.fn().mockResolvedValue(undefined),
    send: jest.fn().mockResolvedValue("job-1"),
    stop: jest.fn().mockResolvedValue(undefined),
  })),
);

jest.mock("../db/pool", () => ({ query: jest.fn() }));
jest.mock("./claude", () => ({
  generateProjectSummary: jest.fn(),
  SUMMARY_MODEL: "claude-opus-4-7",
}));
jest.mock("./audit", () => ({ logAdminAction: jest.fn() }));
jest.mock("./metrics", () => ({
  metrics: {
    aiSummaryTokensTotal: { inc: jest.fn() },
    aiSummaryCostUsdTotal: { inc: jest.fn() },
    aiSummaryLatencySeconds: { observe: jest.fn() },
    aiSummaryOutcomesTotal: { inc: jest.fn() },
  },
}));
jest.mock("../lib/anthropicPricing", () => ({
  calculateCostUsd: jest.fn(() => ({ costUsd: 0.01, priced: true })),
}));

const PgBoss = require("pg-boss");
const pool = require("../db/pool");
const { generateProjectSummary } = require("./claude");
const { logAdminAction } = require("./audit");
const { metrics } = require("./metrics");
const { calculateCostUsd } = require("../lib/anthropicPricing");
const summaryQueue = require("./summaryQueue");

const PROJECT_ID = "11111111-1111-1111-1111-111111111111";

function getBossInstance() {
  const results = PgBoss.mock.results;
  return results[results.length - 1].value;
}

async function getJobHandler() {
  const boss = getBossInstance();
  // work() is called once, with (queueName, options, handler)
  return boss.work.mock.calls[boss.work.mock.calls.length - 1][2];
}

beforeEach(async () => {
  jest.clearAllMocks();
  // Fresh boss instance + worker registration for each test, so
  // boss.send/boss.work call histories don't bleed across tests.
  await summaryQueue.start(null);
});

afterEach(async () => {
  await summaryQueue.stop();
});

describe("enqueueAISummary", () => {
  it("claims the cooldown and enqueues when the project is not on cooldown", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ ai_summary_generated_at: new Date() }],
    });

    const jobId = await summaryQueue.enqueueAISummary(PROJECT_ID, {
      name: "Reforest Now",
      category: "Reforestation",
      description: "desc",
      adminAddress: "GADMIN",
    });

    expect(jobId).toBe("job-1");
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.query.mock.calls[0][0]).toContain("ai_summary_generated_at = NOW()");

    const boss = getBossInstance();
    expect(boss.send).toHaveBeenCalledWith(
      "ai-summary",
      expect.objectContaining({ projectId: PROJECT_ID, name: "Reforest Now" }),
      { retryLimit: 3, retryDelay: 10 },
    );
  });

  it("rejects with SUMMARY_COOLDOWN_ACTIVE and does not enqueue when the claim UPDATE matches no row", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] }); // claim UPDATE: cooldown still active
    pool.query.mockResolvedValueOnce({
      rows: [{ ai_summary_generated_at: new Date().toISOString() }],
    }); // best-effort SELECT for retryAfterSeconds

    await expect(
      summaryQueue.enqueueAISummary(PROJECT_ID, {
        name: "Reforest Now",
        category: "Reforestation",
        description: "desc",
      }),
    ).rejects.toMatchObject({
      code: "SUMMARY_COOLDOWN_ACTIVE",
      retryAfterSeconds: expect.any(Number),
    });

    const boss = getBossInstance();
    expect(boss.send).not.toHaveBeenCalled();
  });
});

describe("AI summary job worker", () => {
  it("records success metrics, updates the project row, and logs the admin action", async () => {
    const jobHandler = await getJobHandler();

    generateProjectSummary.mockResolvedValueOnce({
      summary: "Three sentences.",
      model: "claude-opus-4-7",
      usage: { input_tokens: 100, output_tokens: 50 },
      latencyMs: 1234,
    });
    pool.query.mockResolvedValueOnce({
      rows: [
        {
          ai_summary: "Three sentences.",
          ai_summary_generated_at: new Date(),
          ai_summary_model: "claude-opus-4-7",
        },
      ],
    });

    await jobHandler({
      data: {
        projectId: PROJECT_ID,
        name: "Reforest Now",
        category: "Reforestation",
        description: "desc",
        adminAddress: "GADMIN",
      },
    });

    expect(metrics.aiSummaryOutcomesTotal.inc).toHaveBeenCalledWith({
      outcome: "success",
      reason: "ok",
    });
    expect(metrics.aiSummaryLatencySeconds.observe).toHaveBeenCalledWith(
      { model: "claude-opus-4-7", outcome: "success" },
      1.234,
    );
    expect(metrics.aiSummaryTokensTotal.inc).toHaveBeenCalledWith(
      { model: "claude-opus-4-7", direction: "input" },
      100,
    );
    expect(metrics.aiSummaryTokensTotal.inc).toHaveBeenCalledWith(
      { model: "claude-opus-4-7", direction: "output" },
      50,
    );
    expect(calculateCostUsd).toHaveBeenCalledWith("claude-opus-4-7", {
      input_tokens: 100,
      output_tokens: 50,
    });
    expect(metrics.aiSummaryCostUsdTotal.inc).toHaveBeenCalledWith(
      { model: "claude-opus-4-7" },
      0.01,
    );
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "project.summary.generated" }),
    );
  });

  it("records error metrics and rethrows (so pg-boss retries) on a transient provider error", async () => {
    const jobHandler = await getJobHandler();

    const err = Object.assign(new Error("Anthropic 500"), {
      reason: "provider_error",
      latencyMs: 500,
    });
    generateProjectSummary.mockRejectedValueOnce(err);

    await expect(
      jobHandler({
        data: {
          projectId: PROJECT_ID,
          name: "X",
          category: "Y",
          description: "Z",
        },
      }),
    ).rejects.toThrow("Anthropic 500");

    expect(metrics.aiSummaryOutcomesTotal.inc).toHaveBeenCalledWith({
      outcome: "error",
      reason: "provider_error",
    });
    expect(metrics.aiSummaryLatencySeconds.observe).toHaveBeenCalledWith(
      { model: "claude-opus-4-7", outcome: "error" },
      0.5,
    );
  });

  it("records the error metric but does not rethrow (no retry) on MISSING_API_KEY", async () => {
    const jobHandler = await getJobHandler();

    const err = Object.assign(new Error("no key"), {
      code: "MISSING_API_KEY",
      reason: "api_key",
      latencyMs: 5,
    });
    generateProjectSummary.mockRejectedValueOnce(err);

    await expect(
      jobHandler({
        data: {
          projectId: PROJECT_ID,
          name: "X",
          category: "Y",
          description: "Z",
        },
      }),
    ).resolves.toBeUndefined();

    expect(metrics.aiSummaryOutcomesTotal.inc).toHaveBeenCalledWith({
      outcome: "error",
      reason: "api_key",
    });
  });
});

/**
 * Issue #929: fallback behavior when the Claude provider is unavailable.
 * `summaryQueue`'s worker must never fail the job silently — it degrades
 * to the project's existing (stale) summary, or a rule-based template
 * when there is no existing summary, instead of leaving the donor-facing
 * field stuck or throwing indefinitely.
 */

let capturedHandler = null;
const mockOn = jest.fn();
const mockStart = jest.fn().mockResolvedValue(undefined);
const mockCreateQueue = jest.fn().mockResolvedValue(undefined);
const mockWork = jest.fn().mockImplementation((_queue, _opts, handler) => {
  capturedHandler = handler;
  return Promise.resolve();
});
const mockStop = jest.fn().mockResolvedValue(undefined);

jest.mock("pg-boss", () =>
  jest.fn().mockImplementation(() => ({
    on: mockOn,
    start: mockStart,
    createQueue: mockCreateQueue,
    work: mockWork,
    stop: mockStop,
  })),
);

const mockQuery = jest.fn();
jest.mock("../db/pool", () => ({
  query: (...args) => mockQuery(...args),
}));

const mockGenerateProjectSummary = jest.fn();
jest.mock("./claude", () => ({
  generateProjectSummary: (...args) => mockGenerateProjectSummary(...args),
}));

const mockLogAdminAction = jest.fn().mockResolvedValue(undefined);
jest.mock("./audit", () => ({
  logAdminAction: (...args) => mockLogAdminAction(...args),
}));

jest.mock("../logger", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const PROJECT_ID = "33333333-3333-3333-3333-333333333333";
const JOB_DATA = {
  projectId: PROJECT_ID,
  name: "Reef Restoration",
  category: "ocean",
  description: "Rebuilds coral reefs.",
  adminAddress: "GADMIN",
};

function retryableError(message = "rate limited") {
  const err = new Error(message);
  err.retryable = true;
  err.breakerOpen = false;
  return err;
}

function exhaustedError(message = "provider down") {
  const err = new Error(message);
  err.retryable = false;
  err.breakerOpen = true;
  return err;
}

async function loadAndStart() {
  let mod;
  jest.isolateModules(() => {
    mod = require("./summaryQueue");
  });
  await mod.start(null);
  return mod;
}

describe("summaryQueue fallback behavior", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    capturedHandler = null;
  });

  test("successful generation updates the project and logs a normal outcome", async () => {
    await loadAndStart();

    mockQuery
      .mockResolvedValueOnce({ rows: [{ ai_summary: null, ai_summary_model: null }] }) // existing lookup
      .mockResolvedValueOnce({
        rows: [
          {
            ai_summary: "Fresh summary.",
            ai_summary_generated_at: new Date(),
            ai_summary_model: "claude-opus-4-7",
          },
        ],
      }); // UPDATE ... RETURNING

    mockGenerateProjectSummary.mockResolvedValueOnce({
      summary: "Fresh summary.",
      model: "claude-opus-4-7",
      cached: false,
    });

    await capturedHandler([{ data: JOB_DATA }]);

    expect(mockLogAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "project.summary.generated" }),
    );
  });

  test("a still-retryable error is rethrown so pg-boss retries the job", async () => {
    await loadAndStart();

    mockQuery.mockResolvedValueOnce({
      rows: [{ ai_summary: "Old summary.", ai_summary_model: "claude-opus-4-7" }],
    });
    mockGenerateProjectSummary.mockRejectedValueOnce(retryableError());

    await expect(capturedHandler([{ data: JOB_DATA }])).rejects.toThrow(
      "rate limited",
    );
    // Only the existing-summary lookup ran — no UPDATE, no fallback.
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });

  test("provider exhausted with an existing summary falls back to it (stale) without rewriting the row", async () => {
    await loadAndStart();

    mockQuery.mockResolvedValueOnce({
      rows: [{ ai_summary: "Existing summary.", ai_summary_model: "claude-opus-4-7" }],
    });
    mockGenerateProjectSummary.mockRejectedValueOnce(exhaustedError());

    await capturedHandler([{ data: JOB_DATA }]);

    // Only the SELECT ran — no UPDATE for a stale fallback.
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockLogAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "project.summary.fallback_stale" }),
    );
  });

  test("provider exhausted with no existing summary degrades to a rule-based fallback", async () => {
    await loadAndStart();

    mockQuery
      .mockResolvedValueOnce({ rows: [{ ai_summary: null, ai_summary_model: null }] })
      .mockResolvedValueOnce({
        rows: [
          {
            ai_summary: "Rule-based fallback text.",
            ai_summary_generated_at: new Date(),
            ai_summary_model: "fallback-rule-based",
          },
        ],
      });
    mockGenerateProjectSummary.mockRejectedValueOnce(exhaustedError());

    await capturedHandler([{ data: JOB_DATA }]);

    expect(mockQuery).toHaveBeenCalledTimes(2);
    const updateCall = mockQuery.mock.calls[1];
    expect(updateCall[1][1]).toBe("fallback-rule-based"); // model param
    expect(mockLogAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "project.summary.fallback_generated" }),
    );
  });

  test("a missing API key skips the job without throwing or writing anything", async () => {
    await loadAndStart();

    mockQuery.mockResolvedValueOnce({
      rows: [{ ai_summary: null, ai_summary_model: null }],
    });
    const err = new Error("ANTHROPIC_API_KEY is not set");
    err.code = "MISSING_API_KEY";
    mockGenerateProjectSummary.mockRejectedValueOnce(err);

    await expect(capturedHandler([{ data: JOB_DATA }])).resolves.toBeUndefined();
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });
});

