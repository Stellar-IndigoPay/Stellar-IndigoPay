"use strict";

jest.mock("../db/pool", () => ({ query: jest.fn() }));

const mockOn = jest.fn();
const mockStart = jest.fn().mockResolvedValue(undefined);
const mockWork = jest.fn().mockResolvedValue(undefined);
const mockSend = jest.fn().mockResolvedValue("job-id");
const mockStop = jest.fn().mockResolvedValue(undefined);

jest.mock("pg-boss", () =>
  jest.fn().mockImplementation(() => ({
    on: mockOn,
    start: mockStart,
    work: mockWork,
    send: mockSend,
    stop: mockStop,
  })),
);

jest.mock("./pushService", () => ({
  sendDonationReceipt: jest.fn().mockResolvedValue(undefined),
  sendMilestoneReachedNotifications: jest.fn().mockResolvedValue(undefined),
  sendProjectUpdateNotifications: jest.fn().mockResolvedValue(undefined),
}));

/**
 * `pushQueue` keeps its pg-boss instance in module-level state, so each
 * test needs a fully isolated require of pushQueue + its dependencies
 * (pool, pushService) — otherwise state (or stale mock references) would
 * leak between tests that call start().
 */
function loadPushQueue() {
  let mod = {};
  jest.isolateModules(() => {
    mod.pool = require("../db/pool");
    mod.pushService = require("./pushService");
    mod.pushQueue = require("./pushQueue");
  });
  return mod;
}

describe("pushQueue", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("enqueuePushNotification throws before the queue is started", async () => {
    const { pushQueue } = loadPushQueue();
    await expect(
      pushQueue.enqueuePushNotification({
        type: "donation_receipt",
        payload: {},
      }),
    ).rejects.toThrow("pushQueue not started");
  });

  test("enqueuePushNotification rejects unknown job types", async () => {
    const { pushQueue } = loadPushQueue();
    await expect(
      pushQueue.enqueuePushNotification({ type: "not_a_type", payload: {} }),
    ).rejects.toThrow("Unknown push notification type: not_a_type");
  });

  test("start() registers a worker and enqueuePushNotification sends a job", async () => {
    const { pushQueue } = loadPushQueue();
    await pushQueue.start();

    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(mockWork).toHaveBeenCalledWith(
      "push-notifications",
      { teamSize: 2, teamConcurrency: 1 },
      expect.any(Function),
    );

    await pushQueue.enqueuePushNotification({
      type: "milestone_reached",
      payload: { projectId: "proj-1", percentage: 50 },
    });

    expect(mockSend).toHaveBeenCalledWith(
      "push-notifications",
      {
        type: "milestone_reached",
        payload: { projectId: "proj-1", percentage: 50 },
      },
      { retryLimit: 3, retryDelay: 10 },
    );
  });

  test("start() is idempotent", async () => {
    const { pushQueue } = loadPushQueue();
    await pushQueue.start();
    await pushQueue.start();
    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  test("stop() is a no-op when the queue was never started", async () => {
    const { pushQueue } = loadPushQueue();
    await pushQueue.stop();
    expect(mockStop).not.toHaveBeenCalled();
  });

  test("stop() gracefully stops pg-boss once started", async () => {
    const { pushQueue } = loadPushQueue();
    await pushQueue.start();
    await pushQueue.stop();
    expect(mockStop).toHaveBeenCalledWith({ graceful: true, timeout: 15_000 });
  });

  describe("job handler dispatch", () => {
    async function getWorkerHandler() {
      const { pushQueue, pool, pushService } = loadPushQueue();
      await pushQueue.start();
      const handler = mockWork.mock.calls[0][2];
      return { handler, pool, pushService };
    }

    test("donation_receipt job looks up the project name and calls sendDonationReceipt", async () => {
      const { handler, pool, pushService } = await getWorkerHandler();
      pool.query.mockResolvedValueOnce({
        rows: [{ name: "Mangrove Restoration" }],
      });

      await handler({
        data: {
          type: "donation_receipt",
          payload: {
            donorAddress: "GDONOR",
            projectId: "proj-1",
            donationId: "donation-1",
            amount: "10",
            currency: "XLM",
          },
        },
      });

      expect(pool.query).toHaveBeenCalledWith(
        "SELECT name FROM projects WHERE id = $1",
        ["proj-1"],
      );
      expect(pushService.sendDonationReceipt).toHaveBeenCalledWith("GDONOR", {
        amount: "10",
        currency: "XLM",
        projectId: "proj-1",
        projectName: "Mangrove Restoration",
        id: "donation-1",
      });
    });

    test("donation_receipt job falls back to a generic project name when missing", async () => {
      const { handler, pool, pushService } = await getWorkerHandler();
      pool.query.mockResolvedValueOnce({ rows: [] });

      await handler({
        data: {
          type: "donation_receipt",
          payload: {
            donorAddress: "GDONOR",
            projectId: "proj-missing",
            donationId: "donation-1",
            amount: "10",
            currency: "XLM",
          },
        },
      });

      expect(pushService.sendDonationReceipt).toHaveBeenCalledWith(
        "GDONOR",
        expect.objectContaining({ projectName: "your project" }),
      );
    });

    test("milestone_reached job looks up the project name and calls sendMilestoneReachedNotifications", async () => {
      const { handler, pool, pushService } = await getWorkerHandler();
      pool.query.mockResolvedValueOnce({
        rows: [{ name: "Mangrove Restoration" }],
      });

      await handler({
        data: {
          type: "milestone_reached",
          payload: { projectId: "proj-1", percentage: 75 },
        },
      });

      expect(
        pushService.sendMilestoneReachedNotifications,
      ).toHaveBeenCalledWith({
        projectId: "proj-1",
        projectName: "Mangrove Restoration",
        percentage: 75,
      });
    });

    test("project_update job passes the payload straight through", async () => {
      const { handler, pushService } = await getWorkerHandler();

      const project = { id: "proj-1", name: "Mangrove Restoration" };
      const update = { id: "update-1", title: "We planted 500 trees!" };

      await handler({
        data: { type: "project_update", payload: { project, update } },
      });

      expect(pushService.sendProjectUpdateNotifications).toHaveBeenCalledWith({
        project,
        update,
      });
    });

    test("unknown job type is logged and does not throw", async () => {
      const { handler, pushService } = await getWorkerHandler();

      await expect(
        handler({ data: { type: "smoke_signal", payload: {} } }),
      ).resolves.toBeUndefined();

      expect(pushService.sendDonationReceipt).not.toHaveBeenCalled();
      expect(pushService.sendMilestoneReachedNotifications).not.toHaveBeenCalled();
      expect(pushService.sendProjectUpdateNotifications).not.toHaveBeenCalled();
    });
  });
});
