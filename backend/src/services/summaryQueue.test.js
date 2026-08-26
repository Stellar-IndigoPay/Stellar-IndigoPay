"use strict";

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
