jest.mock("../../src/db/pool", () => ({
  query: jest.fn(),
  connect: jest.fn(),
}));

jest.mock("../../src/logger", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock("../../src/services/stellar", () => ({
  server: {
    ledgers: jest.fn(() => ({
      order: jest.fn(() => ({
        limit: jest.fn(() => ({
          call: jest.fn().mockResolvedValue({ records: [{ sequence: 110 }] }),
        })),
      })),
    })),
  },
}));

jest.mock("../../src/services/indexerDLQWorker", () => ({
  enqueue: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../src/services/indexerBackfill", () => ({
  runBackfill: jest.fn(),
}));

jest.mock("../../src/services/indexerDonationHandler", () => ({
  handleDonation: jest.fn().mockResolvedValue(true),
  setUsdcToXlmRate: jest.fn(),
}));

jest.mock("../../src/services/metrics", () => ({
  registry: { registerMetric: jest.fn() },
  metrics: {
    indigopayIndexerStreamReconnectsTotal: { inc: jest.fn() },
    indexerOperationsSkippedTotal: { inc: jest.fn() },
    indigopayIndexerLagLedgers: { set: jest.fn() },
    indigopayIndexerAutoBackfillsTotal: { inc: jest.fn() },
  },
}));

const pool = require("../../src/db/pool");
const { runBackfill } = require("../../src/services/indexerBackfill");
const { metrics } = require("../../src/services/metrics");
const {
  runLagCheck,
  setLagRuntimeState,
  getLagRuntimeState,
  resetLagRuntimeState,
  stop,
} = require("../../src/services/indexerService");

describe("indexer lag detection", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pool.query.mockResolvedValue({
      rows: [{ last_processed_ledger: 100 }],
    });
    runBackfill.mockReset();
    resetLagRuntimeState();
    setLagRuntimeState({
      backoffMs: 30_000,
      lastBackfillOutcome: null,
    });
  });

  afterEach(async () => {
    await stop();
  });

  it("calculates lag and triggers a backfill when the threshold is exceeded", async () => {
    runBackfill.mockResolvedValue({ processed: 2, errors: 0 });

    const result = await runLagCheck();

    expect(result).toEqual({
      lag: 10,
      triggeredBackfill: true,
      outcome: "success",
    });
    expect(runBackfill).toHaveBeenCalledWith({
      fromLedger: 101,
      toLedger: 110,
    });
    expect(metrics.indigopayIndexerLagLedgers.set).toHaveBeenCalledWith(10);
    expect(getLagRuntimeState().lastProcessedLedger).toBe(100);
  });

  it("increases the backoff after a failed backfill", async () => {
    runBackfill.mockRejectedValue(new Error("boom"));

    const result = await runLagCheck();

    expect(result).toEqual({
      lag: 10,
      triggeredBackfill: true,
      outcome: "failed",
    });
    expect(getLagRuntimeState()).toMatchObject({
      backoffMs: 60_000,
      lastBackfillOutcome: "failed",
    });
    expect(metrics.indigopayIndexerAutoBackfillsTotal.inc).toHaveBeenCalledWith({
      outcome: "failed",
    });
  });
});
