"use strict";

jest.mock("../db/pool", () => ({ query: jest.fn() }));

const mockIsExpoPushToken = jest.fn();
const mockChunkPushNotifications = jest.fn();
const mockSendPushNotificationsAsync = jest.fn();

jest.mock("expo-server-sdk", () => ({
  Expo: Object.assign(
    jest.fn().mockImplementation(() => ({
      chunkPushNotifications: mockChunkPushNotifications,
      sendPushNotificationsAsync: mockSendPushNotificationsAsync,
    })),
    { isExpoPushToken: mockIsExpoPushToken },
  ),
}));

const pool = require("../db/pool");
const pushService = require("./pushService");

function chunkPassthrough(messages) {
  return messages.length === 0 ? [] : [messages];
}

describe("pushService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsExpoPushToken.mockReturnValue(true);
    mockChunkPushNotifications.mockImplementation(chunkPassthrough);
  });

  describe("sendPushNotification", () => {
    test("does not send when the wallet opted out of this notification type", async () => {
      pool.query.mockResolvedValueOnce({ rows: [{ enabled: false }] }); // preference check

      const result = await pushService.sendPushNotification({
        walletAddress: "GDONOR",
        title: "Hi",
        body: "Body",
        data: { type: "donation_receipt" },
      });

      expect(result).toBeNull();
      expect(pool.query).toHaveBeenCalledTimes(1);
      expect(mockSendPushNotificationsAsync).not.toHaveBeenCalled();
    });

    test("sends to every valid token and records a delivered ticket", async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [] }) // preference check: no row => opted in
        .mockResolvedValueOnce({ rows: [{ token: "ExponentPushToken[abc]" }] }) // device tokens
        .mockResolvedValueOnce({ rows: [] }); // delivery insert

      mockSendPushNotificationsAsync.mockResolvedValueOnce([
        { status: "ok", id: "ticket-1" },
      ]);

      const tickets = await pushService.sendPushNotification({
        walletAddress: "GDONOR",
        title: "Hi",
        body: "Body",
        data: { type: "donation_receipt" },
      });

      expect(tickets).toEqual([{ status: "ok", id: "ticket-1" }]);
      expect(mockSendPushNotificationsAsync).toHaveBeenCalledWith([
        {
          to: "ExponentPushToken[abc]",
          sound: "default",
          title: "Hi",
          body: "Body",
          data: { type: "donation_receipt", walletAddress: "GDONOR" },
        },
      ]);

      const insertCall = pool.query.mock.calls[2];
      expect(insertCall[0]).toEqual(expect.stringContaining("INSERT INTO push_notifications"));
      expect(insertCall[1]).toEqual([
        expect.any(String),
        "GDONOR",
        "ExponentPushToken[abc]",
        "Hi",
        "Body",
        JSON.stringify({ type: "donation_receipt", walletAddress: "GDONOR" }),
        "sent",
        "ticket-1",
        null,
      ]);
    });

    test("skips tokens that aren't valid Expo push tokens", async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [] }) // preference check
        .mockResolvedValueOnce({
          rows: [{ token: "not-an-expo-token" }],
        }); // device tokens

      mockIsExpoPushToken.mockReturnValue(false);

      const tickets = await pushService.sendPushNotification({
        walletAddress: "GDONOR",
        title: "Hi",
        body: "Body",
        data: { type: "donation_receipt" },
      });

      expect(tickets).toEqual([]);
      expect(mockSendPushNotificationsAsync).not.toHaveBeenCalled();
    });

    test("records a failed delivery per token when a ticket reports an error, without throwing", async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [] }) // preference check
        .mockResolvedValueOnce({ rows: [{ token: "ExponentPushToken[dead]" }] }) // device tokens
        .mockResolvedValueOnce({ rows: [] }); // delivery insert

      mockSendPushNotificationsAsync.mockResolvedValueOnce([
        {
          status: "error",
          message: "DeviceNotRegistered",
          details: { error: "DeviceNotRegistered" },
        },
      ]);

      const tickets = await pushService.sendPushNotification({
        walletAddress: "GDONOR",
        title: "Hi",
        body: "Body",
        data: { type: "donation_receipt" },
      });

      expect(tickets).toHaveLength(1);
      const insertCall = pool.query.mock.calls[2];
      expect(insertCall[1]).toEqual([
        expect.any(String),
        "GDONOR",
        "ExponentPushToken[dead]",
        "Hi",
        "Body",
        expect.any(String),
        "failed",
        null,
        "DeviceNotRegistered",
      ]);
    });

    test("records chunk-level send failures as failed deliveries instead of throwing", async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [] }) // preference check
        .mockResolvedValueOnce({ rows: [{ token: "ExponentPushToken[abc]" }] }) // device tokens
        .mockResolvedValueOnce({ rows: [] }); // delivery insert

      mockSendPushNotificationsAsync.mockRejectedValueOnce(
        new Error("Expo API unavailable"),
      );

      const tickets = await pushService.sendPushNotification({
        walletAddress: "GDONOR",
        title: "Hi",
        body: "Body",
        data: { type: "donation_receipt" },
      });

      expect(tickets).toEqual([]);
      const insertCall = pool.query.mock.calls[2];
      expect(insertCall[1][6]).toBe("failed");
      expect(insertCall[1][8]).toBe("Expo API unavailable");
    });
  });

  describe("sendDonationReceipt", () => {
    test("builds the expected title/body/data and delegates to sendPushNotification", async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [] }) // preference check
        .mockResolvedValueOnce({ rows: [] }); // no device tokens

      await pushService.sendDonationReceipt("GDONOR", {
        amount: "10.0000000",
        currency: "XLM",
        projectId: "proj-1",
        projectName: "Mangrove Restoration",
        id: "donation-1",
      });

      // preference check query args
      expect(pool.query.mock.calls[0][1]).toEqual([
        "GDONOR",
        "donation_receipt",
      ]);
      // device token lookup happens for the same wallet
      expect(pool.query.mock.calls[1][1]).toEqual(["GDONOR"]);
    });
  });

  describe("sendMilestoneReachedNotifications", () => {
    test("notifies every wallet-linked follower and skips anonymous ones", async () => {
      pool.query
        .mockResolvedValueOnce({
          rows: [{ wallet_address: "GFOLLOWER1" }, { wallet_address: "GFOLLOWER2" }],
        }) // followers query (already filters wallet_address IS NOT NULL)
        .mockResolvedValueOnce({ rows: [] }) // pref check follower1
        .mockResolvedValueOnce({ rows: [] }) // tokens follower1
        .mockResolvedValueOnce({ rows: [] }) // pref check follower2
        .mockResolvedValueOnce({ rows: [] }); // tokens follower2

      await pushService.sendMilestoneReachedNotifications({
        projectId: "proj-1",
        projectName: "Mangrove Restoration",
        percentage: 50,
      });

      expect(pool.query.mock.calls[0][1]).toEqual(["proj-1"]);
      expect(pool.query.mock.calls[1][1]).toEqual(["GFOLLOWER1", "milestone_reached"]);
      expect(pool.query.mock.calls[3][1]).toEqual(["GFOLLOWER2", "milestone_reached"]);
    });
  });

  describe("sendProjectUpdateNotifications", () => {
    test("sends to anonymous device follows without checking preferences", async () => {
      pool.query
        .mockResolvedValueOnce({
          rows: [{ token: "ExponentPushToken[anon]", wallet_address: null }],
        }) // followers
        .mockResolvedValueOnce({ rows: [] }); // delivery insert

      mockSendPushNotificationsAsync.mockResolvedValueOnce([
        { status: "ok", id: "ticket-anon" },
      ]);

      const tickets = await pushService.sendProjectUpdateNotifications({
        project: { id: "proj-1", name: "Mangrove Restoration" },
        update: { id: "update-1", title: "We planted 500 trees!" },
      });

      expect(tickets).toEqual([{ status: "ok", id: "ticket-anon" }]);
      // Only 2 queries total: followers + delivery record (no preference check for anon follows)
      expect(pool.query).toHaveBeenCalledTimes(2);
    });

    test("skips wallet-linked followers who opted out", async () => {
      pool.query
        .mockResolvedValueOnce({
          rows: [{ token: "ExponentPushToken[opted-out]", wallet_address: "GOPTOUT" }],
        }) // followers
        .mockResolvedValueOnce({ rows: [{ enabled: false }] }); // preference check

      const tickets = await pushService.sendProjectUpdateNotifications({
        project: { id: "proj-1", name: "Mangrove Restoration" },
        update: { id: "update-1", title: "We planted 500 trees!" },
      });

      expect(tickets).toEqual([]);
      expect(mockSendPushNotificationsAsync).not.toHaveBeenCalled();
    });
  });
});
