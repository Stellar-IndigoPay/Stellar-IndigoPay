"use strict";

jest.mock("../db/pool", () => ({
  query: jest.fn(),
  connect: jest.fn(),
}));

jest.mock("./webhookQueue", () => ({
  enqueueWebhookDelivery: jest.fn().mockResolvedValue("event-id"),
}));

jest.mock("./pushQueue", () => ({
  enqueuePushNotification: jest.fn().mockResolvedValue("job-id"),
}));

const pool = require("../db/pool");
const { enqueueWebhookDelivery } = require("./webhookQueue");
const { enqueuePushNotification } = require("./pushQueue");
const { checkAndDeliverMilestones } = require("./webhook");

function makeClient() {
  return {
    query: jest.fn().mockResolvedValue({ rows: [] }),
    release: jest.fn(),
  };
}

describe("checkAndDeliverMilestones", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("enqueues a push notification per reached milestone even without a webhook configured", async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "proj-1",
            goal_xlm: "100",
            raised_xlm: "50",
            webhook_url: null,
            webhook_secret: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ id: "milestone-1", percentage: 50, title: "Halfway there" }],
      });

    const client = makeClient();
    pool.connect.mockResolvedValueOnce(client);

    await checkAndDeliverMilestones("proj-1");

    expect(client.query).toHaveBeenCalledWith("BEGIN");
    expect(client.query).toHaveBeenCalledWith("COMMIT");
    expect(client.release).toHaveBeenCalledTimes(1);

    expect(enqueuePushNotification).toHaveBeenCalledWith({
      type: "milestone_reached",
      payload: { projectId: "proj-1", percentage: 50 },
    });
    expect(enqueueWebhookDelivery).not.toHaveBeenCalled();
  });

  test("enqueues both a webhook delivery and a push notification when a webhook is configured", async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "proj-1",
            goal_xlm: "100",
            raised_xlm: "100",
            webhook_url: "https://example.com/hook",
            webhook_secret: "shh",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ id: "milestone-1", percentage: 100, title: "Fully funded" }],
      });

    const client = makeClient();
    pool.connect.mockResolvedValueOnce(client);

    await checkAndDeliverMilestones("proj-1");

    expect(enqueueWebhookDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "proj-1", eventType: "milestone.reached" }),
    );
    expect(enqueuePushNotification).toHaveBeenCalledWith({
      type: "milestone_reached",
      payload: { projectId: "proj-1", percentage: 100 },
    });
  });

  test("does nothing when no milestones were newly reached", async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "proj-1",
            goal_xlm: "100",
            raised_xlm: "10",
            webhook_url: null,
            webhook_secret: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    await checkAndDeliverMilestones("proj-1");

    expect(pool.connect).not.toHaveBeenCalled();
    expect(enqueuePushNotification).not.toHaveBeenCalled();
    expect(enqueueWebhookDelivery).not.toHaveBeenCalled();
  });

  test("a push enqueue failure is logged and does not throw", async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "proj-1",
            goal_xlm: "100",
            raised_xlm: "50",
            webhook_url: null,
            webhook_secret: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ id: "milestone-1", percentage: 50, title: "Halfway there" }],
      });

    const client = makeClient();
    pool.connect.mockResolvedValueOnce(client);
    enqueuePushNotification.mockRejectedValueOnce(new Error("queue down"));

    await expect(checkAndDeliverMilestones("proj-1")).resolves.toBeUndefined();
  });
});
