"use strict";

/**
 * services/moderation.test.js
 *
 * Lifecycle of the project-update moderation pipeline (issue #935):
 *   submitted -> live (rules clean / AI clean)
 *   submitted -> quarantined (hard rule / AI flag / retroactive re-screen)
 *   degrade -> live with AI error recorded, softly.
 * Plus the audited admin decision path and the deterministic AI cache.
 */

process.env.ANTHROPIC_API_KEY = "test-key";
process.env.CLAUDE_MODERATION_RETRY_BASE_MS = "1";
process.env.CLAUDE_MODERATION_MAX_RETRIES = "1";
process.env.CLAUDE_MODERATION_BREAKER_THRESHOLD = "10";

const mockCreate = jest.fn();
jest.mock("@anthropic-ai/sdk", () =>
  jest.fn().mockImplementation(() => ({
    messages: { create: (...args) => mockCreate(...args) },
  })),
);

jest.mock("../db/pool", () => ({
  query: jest.fn(),
  connect: jest.fn(),
}));

jest.mock("./audit", () => ({
  logAdminAction: jest.fn().mockResolvedValue(undefined),
}));

const pool = require("../db/pool");
const { logAdminAction } = require("./audit");
const moderation = require("./moderation");

const UPDATE_ID = "11111111-1111-4111-8111-111111111111";

function row(overrides = {}) {
  return {
    id: UPDATE_ID,
    project_id: "22222222-2222-4222-8222-222222222222",
    title: "We planted 500 trees",
    body: "Big milestone for the grove.",
    created_at: "2026-07-01T00:00:00.000Z",
    moderation_status: "pending-screening",
    moderation_screening: null,
    moderation_screened_at: null,
    moderation_reviewed_by: null,
    moderation_reviewed_at: null,
    moderation_rationale: null,
    moderation_alerted: false,
    ...overrides,
  };
}

function softRow() {
  return row({
    title: "Urgent!",
    body: "Make $5000 a day guaranteed profit no risk.",
    moderation_status: "pending-screening",
  });
}

function hardRow() {
  return row({
    title: "Bonus",
    body: "Connect your wallet at http://10.0.0.1/verify",
    moderation_status: "pending-screening",
  });
}

function verdictResponse(text, overrides = {}) {
  return {
    model: "claude-opus-4-7",
    content: [{ type: "text", text }],
    usage: { input_tokens: 100, output_tokens: 50 },
    ...overrides,
  };
}

const CLEAN_VERDICT = JSON.stringify({
  label: "clean",
  confidence: 0.98,
  rationale: "Normal project update.",
});
const PHISHING_VERDICT = JSON.stringify({
  label: "phishing",
  confidence: 0.97,
  rationale: "Wallet harvest link.",
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe("screenProjectUpdate — rule fast path", () => {
  test("clean content promotes straight to live and fires onLive", async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [row()] }) // loadUpdate
      .mockResolvedValueOnce({ rows: [row({ moderation_status: "live" })] }); // setLive

    const onLive = jest.fn();
    const outcome = await moderation.screenProjectUpdate({
      updateId: UPDATE_ID,
      onLive,
    });

    expect(outcome).toEqual({ outcome: "live", reason: "rules_clean" });
    expect(onLive).toHaveBeenCalledTimes(1);
    expect(onLive.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        id: UPDATE_ID,
        moderationStatus: "live",
      }),
    );
  });

  test("a hard rule verdict auto-quarantines and raises an alert", async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [hardRow()] }) // loadUpdate
      .mockResolvedValueOnce({
        rows: [hardRow({ moderation_status: "quarantined" })],
      }); // setAutoQuarantine

    const outcome = await moderation.screenProjectUpdate({ updateId: UPDATE_ID });

    expect(outcome.outcome).toBe("quarantined");
    expect(outcome.reason).toBe("rule_hard_violation");
    expect(logAdminAction).toHaveBeenCalledTimes(1);
    expect(logAdminAction.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        action: "update.auto_quarantined",
        targetId: UPDATE_ID,
      }),
    );
  });

  test("an already-decided (quarantined) update is never touched", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [row({ moderation_status: "quarantined" })],
    });

    const outcome = await moderation.screenProjectUpdate({ updateId: UPDATE_ID });

    expect(outcome.outcome).toBe("already_decided");
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  test("never throws to the caller — returns the error instead", async () => {
    pool.query.mockRejectedValueOnce(new Error("db down"));

    const outcome = await moderation.screenProjectUpdate({ updateId: UPDATE_ID });

    expect(outcome.outcome).toBe("error");
  });
});

describe("screenProjectUpdate — AI review path", () => {
  test("soft review + clean AI verdict promotes to live with the trail recorded", async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [softRow()] }) // loadUpdate
      .mockResolvedValueOnce({ rows: [] }) // getCachedVerdict (miss)
      .mockResolvedValueOnce({ rows: [] }) // storeCachedVerdict
      .mockResolvedValueOnce({
        rows: [softRow({ moderation_status: "live" })],
      }); // setLive
    mockCreate.mockResolvedValueOnce(verdictResponse(CLEAN_VERDICT));

    const outcome = await moderation.screenProjectUpdate({ updateId: UPDATE_ID });

    expect(outcome.outcome).toBe("live");
    expect(outcome.reason).toBe("ai_clean");
    // Screening trail (including the AI verdict) is persisted on the row.
    const updateCall = pool.query.mock.calls.find(([sql]) =>
      sql.includes("SET moderation_status = 'live'"),
    );
    expect(JSON.parse(updateCall[1][1]).ai.verdict).toBe("clean");
  });

  test("soft review + phishing AI verdict auto-quarantines with an alert", async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [softRow()] }) // loadUpdate
      .mockResolvedValueOnce({ rows: [] }) // getCachedVerdict (miss)
      .mockResolvedValueOnce({ rows: [] }) // storeCachedVerdict
      .mockResolvedValueOnce({
        rows: [softRow({ moderation_status: "quarantined" })],
      }); // setAutoQuarantine
    mockCreate.mockResolvedValueOnce(verdictResponse(PHISHING_VERDICT));

    const outcome = await moderation.screenProjectUpdate({ updateId: UPDATE_ID });

    expect(outcome.outcome).toBe("quarantined");
    expect(outcome.reason).toBe("ai_hard_flag");
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "update.auto_quarantined" }),
    );
  });

  test("AI outage degrades to a flagged live row (documented trade-off)", async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [softRow()] }) // loadUpdate
      .mockResolvedValueOnce({ rows: [] }) // getCachedVerdict (miss)
      .mockResolvedValueOnce({
        rows: [softRow({ moderation_status: "live" })],
      }); // setLive
    mockCreate.mockRejectedValueOnce(new Error("provider down"));

    const outcome = await moderation.screenProjectUpdate({ updateId: UPDATE_ID });

    expect(outcome.outcome).toBe("live");
    expect(outcome.reason).toBe("ai_unavailable_degraded");
    // The degrade decision is recorded so a future re-screen can quarantine
    // retroactively.
    const updateCall = pool.query.mock.calls.find(([sql]) =>
      sql.includes("SET moderation_status = 'live'"),
    );
    const screening = JSON.parse(updateCall[1][1]);
    expect(screening.ai.degraded).toBe(true);
    expect(screening.ai.verdict).toBeNull();
  });

  test("a cached AI verdict skips the provider entirely", async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [softRow()] }) // loadUpdate
      .mockResolvedValueOnce({
        rows: [
          {
            verdict: "clean",
            confidence: "0.95",
            rationale: "Cached.",
            model: "claude-opus-4-7",
            template_version: moderation.MODERATION_TEMPLATE_SLUG,
          },
        ],
      }) // getCachedVerdict (hit)
      .mockResolvedValueOnce({
        rows: [softRow({ moderation_status: "live" })],
      }); // setLive

    const outcome = await moderation.screenProjectUpdate({ updateId: UPDATE_ID });

    expect(outcome.outcome).toBe("live");
    expect(outcome.reason).toBe("ai_clean");
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe("recheckPendingAiScreenings — no silent live content", () => {
  test("retroactively quarantines degraded-live content the AI now flags", async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: UPDATE_ID,
            title: "Urgent!",
            body: "Make $5000 a day guaranteed profit no risk.",
          },
        ],
      }) // find degraded-live rows (jsonb filter)
      .mockResolvedValueOnce({ rows: [softRow()] }) // inner loadUpdate
      .mockResolvedValueOnce({ rows: [] }) // getCachedVerdict
      .mockResolvedValueOnce({ rows: [] }) // storeCachedVerdict
      .mockResolvedValueOnce({
        rows: [softRow({ moderation_status: "quarantined" })],
      }); // setAutoQuarantine
    mockCreate.mockResolvedValueOnce(verdictResponse(PHISHING_VERDICT));

    const report = await moderation.recheckPendingAiScreenings({ limit: 10 });

    expect(report).toEqual(
      expect.objectContaining({ screened: 1, quarantined: 1, errors: 0 }),
    );
    // The re-screen SQL targets degraded live rows only.
    expect(
      pool.query.mock.calls[0][0].includes("moderation_screening -> 'ai'"),
    ).toBe(true);
  });
});

describe("decideModeration — admin decisions are audited and terminal-safe", () => {
  function clientMock({ found = true, status = "live" } = {}) {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: found ? [{ id: UPDATE_ID }] : [] }) // FOR UPDATE
      .mockResolvedValueOnce({
        rows: [row({ moderation_status: status, moderation_screening: { ai: null } })],
      }) // UPDATE ... RETURNING *
      .mockResolvedValueOnce({ rows: [] }); // COMMIT
    return { query, release: jest.fn() };
  }

  test("approve promotes a quarantined update to live", async () => {
    const client = clientMock({ status: "live" });
    pool.connect.mockResolvedValueOnce(client);

    const outcome = await moderation.decideModeration({
      updateId: UPDATE_ID,
      decision: "approve",
      reviewer: "admin-key",
      rationale: "Community report was a false positive.",
    });

    expect(outcome.okay).toBe(true);
    expect(outcome.status).toBe("live");
    expect(outcome.update.moderationStatus).toBe("live");
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: "admin-key",
        action: "update.approve",
        targetId: UPDATE_ID,
      }),
    );
  });

  test("remove is terminal", async () => {
    const client = clientMock({ status: "removed" });
    pool.connect.mockResolvedValueOnce(client);

    const outcome = await moderation.decideModeration({
      updateId: UPDATE_ID,
      decision: "remove",
      reviewer: "admin-key",
    });

    expect(outcome.okay).toBe(true);
    expect(outcome.status).toBe("removed");
  });

  test("missing update returns not-found without recording a decision", async () => {
    const client = clientMock({ found: false });
    pool.connect.mockResolvedValueOnce(client);

    const outcome = await moderation.decideModeration({
      updateId: UPDATE_ID,
      decision: "approve",
      reviewer: "admin-key",
    });

    expect(outcome.okay).toBe(false);
    expect(outcome.error).toBe("update_not_found");
    expect(logAdminAction).not.toHaveBeenCalled();
  });

  test("rejects an invalid decision before touching the database", async () => {
    const outcome = await moderation.decideModeration({
      updateId: UPDATE_ID,
      decision: "delete-even-harder",
      reviewer: "admin-key",
    });

    expect(outcome.okay).toBe(false);
    expect(pool.connect).not.toHaveBeenCalled();
  });
});

describe("parseVerdict — defensive around provider output", () => {
  test("parses bare JSON", () => {
    expect(moderation.parseVerdict('{"label":"clean","confidence":0.9,"rationale":"ok"}')).toEqual({
      label: "clean",
      confidence: 0.9,
      rationale: "ok",
    });
  });

  test("strips markdown fences", () => {
    expect(
      moderation.parseVerdict('```json\n{"label":"spam","confidence":0.7,"rationale":"x"}\n```'),
    ).toEqual({ label: "spam", confidence: 0.7, rationale: "x" });
  });

  test("normalises an unknown label to suspicious", () => {
    expect(
      moderation.parseVerdict('{"label":"extra-clean","confidence":1,"rationale":""}'),
    ).toEqual({ label: "suspicious", confidence: 1, rationale: "" });
  });

  test("clamps out-of-range confidence", () => {
    const parsed = moderation.parseVerdict(
      '{"label":"clean","confidence":12,"rationale":""}',
    );
    expect(parsed.confidence).toBe(1);
  });

  test("throws on missing JSON", () => {
    expect(() => moderation.parseVerdict("not json at all")).toThrow();
  });
});

describe("deterministic cache keys", () => {
  test("identical inputs produce identical cache keys", () => {
    const a = moderation.computeInputHash("Title", "Body");
    const b = moderation.computeInputHash("Title", "Body");
    const c = moderation.computeInputHash("Title", "Other body");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});