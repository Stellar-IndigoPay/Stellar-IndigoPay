"use strict";

jest.mock("../db/pool", () => ({
  query: jest.fn(),
}));

const pool = require("../db/pool");
const {
  isValidQueue,
  getQueueMetrics,
  pauseQueue,
  resumeQueue,
  purgeQueue
} = require("./queueMetrics");

describe("queueMetrics service", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("isValidQueue validates correct names", () => {
    expect(isValidQueue("webhook-deliveries")).toBe(true);
    expect(isValidQueue("ai-summary")).toBe(true);
    expect(isValidQueue("invalid-queue")).toBe(false);
  });

  test("getQueueMetrics executes database queries and maps metrics", async () => {
    const mockStatsResult = {
      rows: [
        {
          name: "webhook-deliveries",
          active: "1",
          waiting: "2",
          failed: "3",
          completed: "4",
          avg_latency: "12.5"
        },
        {
          name: "ai-summary",
          active: "0",
          waiting: "0",
          failed: "0",
          completed: "0",
          avg_latency: null
        }
      ]
    };

    const mockPausedResult = {
      rows: [
        { name: "webhook-deliveries", paused: true },
        { name: "ai-summary", paused: false }
      ]
    };

    pool.query
      .mockResolvedValueOnce(mockStatsResult)
      .mockResolvedValueOnce(mockPausedResult);

    const metrics = await getQueueMetrics();
    expect(metrics).toHaveLength(5);

    const webhook = metrics.find(m => m.queue === "webhook-deliveries");
    expect(webhook.active).toBe(1);
    expect(webhook.waiting).toBe(2);
    expect(webhook.failed).toBe(3);
    expect(webhook.completed).toBe(4);
    expect(webhook.depth).toBe(3);
    expect(webhook.failure_rate).toBe(3 / 7);
    expect(webhook.latency).toBe(12.5);
    expect(webhook.paused).toBe(true);

    const summary = metrics.find(m => m.queue === "ai-summary");
    expect(summary.active).toBe(0);
    expect(summary.waiting).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.completed).toBe(0);
    expect(summary.depth).toBe(0);
    expect(summary.failure_rate).toBe(0);
    expect(summary.latency).toBe(0);
    expect(summary.paused).toBe(false);
  });

  test("getQueueMetrics handles DB errors gracefully", async () => {
    const metrics = await getQueueMetrics();
    expect(metrics).toHaveLength(5);
    metrics.forEach(m => {
      expect(m.active).toBe(0);
      expect(m.paused).toBe(false);
    });
  });

  test("pauseQueue runs correct SQL query", async () => {
    pool.query.mockResolvedValue({ rows: [] });
    await pauseQueue("webhook-deliveries");
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO pgboss.queue"),
      ["webhook-deliveries"]
    );
  });

  test("resumeQueue runs correct SQL query", async () => {
    pool.query.mockResolvedValue({ rows: [] });
    await resumeQueue("ai-summary");
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO pgboss.queue"),
      ["ai-summary"]
    );
  });

  test("purgeQueue runs correct SQL query", async () => {
    pool.query.mockResolvedValue({ rows: [] });
    await purgeQueue("profile-update");
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM pgboss.job"),
      ["profile-update"]
    );
  });
});
