/**
 * backend/__tests__/contractUpgrade.test.js
 *
 * Indexer compatibility test for contract upgrade events.
 */

"use strict";

// ── Mocks ───────────────────────────────────────────────────────────────────

jest.mock("../src/db/pool", () => {
  const queryMock = jest.fn();
  const connectMock = jest.fn();
  return {
    query: queryMock,
    connect: connectMock,
  };
});

jest.mock("../src/services/stellar", () => ({
  rpcServer: {
    getEvents: jest.fn(),
  },
  CONTRACT_ID: "CCONTRACTXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  withRetry: jest.fn((fn) => fn()),
}));

jest.mock("../src/logger", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

// ── Imports ─────────────────────────────────────────────────────────────────

const pool = require("../src/db/pool");
const { rpcServer } = require("../src/services/stellar");
const { pollEvents } = require("../src/services/sorobanEventService");

// ── Helpers ─────────────────────────────────────────────────────────────────

function mockEvent(pagingToken, eventType, topics = [], value = null) {
  // Convert eventType string into base64 XDR ScVal symbol string for topics[0]
  // In the real system topics[0] is XDR. We mock decodeScVal to handle it
  // or return the raw string because decodeScVal has fallback to return raw string if XDR parsing fails.
  return {
    pagingToken,
    ledger: 100,
    topic: [eventType, ...topics],
    value: value,
    txHash: "txhash_" + pagingToken,
  };
}

describe("Contract upgrade — indexer compatibility", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("indexer handles events during contract upgrade without interruption", async () => {
    // 1. Seed events from v1 contract, an upgrade event, and a v2 event
    const events = [
      mockEvent("token1", "proj_reg", ["admin_addr"], "project-v1"),
      mockEvent("token2", "upg_exec", [], "wasm_hash_v2"),
      mockEvent("token3", "proj_reg", ["admin_addr"], "project-v2"),
    ];

    rpcServer.getEvents.mockResolvedValueOnce({ events });

    // Mock loadCursor to return empty initially (start)
    pool.query.mockImplementation((sql, params) => {
      if (sql.includes("SELECT value FROM indexer_state")) {
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO indexer_state")) {
        return { rows: [] };
      }
      return { rows: [] };
    });

    // Run the event poll
    await pollEvents();

    // Verify indexer query was called to save the latest cursor
    const saveCursorCall = pool.query.mock.calls.find(
      ([sql]) => sql.includes("INSERT INTO indexer_state") && sql.includes("soroban_event_cursor")
    );
    expect(saveCursorCall).toBeDefined();
    // Verify cursor updated to the last event's paging token
    expect(saveCursorCall[1][0]).toBe("token3");

    // Verify no events were written to DLQ since all were processed successfully
    const dlqCall = pool.query.mock.calls.find(([sql]) => sql.includes("INSERT INTO soroban_event_dlq"));
    expect(dlqCall).toBeUndefined();
  });

  test("indexer handles new event type introduced in v2 gracefully", async () => {
    // 1. Send a v2-only event type (e.g., "new_v2_feature") that doesn't exist in the current event handler
    const events = [
      mockEvent("token4", "new_v2_feature", ["some_data"], "some_value"),
    ];

    rpcServer.getEvents.mockResolvedValueOnce({ events });

    pool.query.mockImplementation((sql) => {
      if (sql.includes("SELECT value FROM indexer_state")) {
        return { rows: [{ value: "token3" }] };
      }
      return { rows: [] };
    });

    // Run the event poll
    await pollEvents();

    // Verify indexer saved the cursor after processing the unknown event
    const saveCursorCall = pool.query.mock.calls.find(
      ([sql]) => sql.includes("INSERT INTO indexer_state")
    );
    expect(saveCursorCall).toBeDefined();
    expect(saveCursorCall[1][0]).toBe("token4");

    // Verify it was mapped to handleOtherEvent and NOT sent to DLQ (unknown events are logged only)
    const dlqCall = pool.query.mock.calls.find(([sql]) => sql.includes("INSERT INTO soroban_event_dlq"));
    expect(dlqCall).toBeUndefined();
  });

  test("failed events are written to DLQ while maintaining cursor progress", async () => {
    // Simulate a failure in one event handler by making topics extract fail or similar
    // We mock decodeScVal to throw when a specific value is passed
    const events = [
      {
        pagingToken: "token5",
        ledger: 101,
        // Cause parse failure by providing a malformed topics array or trigger error
        topic: null, // this will cause extractEventType to return "unknown" or throw
        value: "error_trigger",
      }
    ];

    rpcServer.getEvents.mockResolvedValueOnce({ events });

    pool.query.mockImplementation((sql, params) => {
      if (sql.includes("SELECT value FROM indexer_state")) {
        return { rows: [{ value: "token4" }] };
      }
      if (sql.includes("INSERT INTO soroban_event_dlq")) {
        return { rows: [{ id: 1 }] }; // Mock successful DLQ insert
      }
      if (sql.includes("INSERT INTO indexer_state")) {
        return { rows: [] };
      }
      return { rows: [] };
    });

    // Run the event poll
    await pollEvents();

    // Verify it was logged and written to DLQ
    const dlqCall = pool.query.mock.calls.find(([sql]) => sql.includes("INSERT INTO soroban_event_dlq"));
    expect(dlqCall).toBeDefined();
    expect(dlqCall[1][0]).toBe("unknown"); // event_type

    // Verify cursor still progresses to prevent infinite processing loops
    const saveCursorCall = pool.query.mock.calls.find(
      ([sql]) => sql.includes("INSERT INTO indexer_state")
    );
    expect(saveCursorCall).toBeDefined();
    expect(saveCursorCall[1][0]).toBe("token5");
  });
});
