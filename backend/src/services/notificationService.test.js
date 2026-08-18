"use strict";

const mockPoolQuery = jest.fn().mockResolvedValue({ rows: [] });

jest.mock("../db/pool", () => ({
  query: mockPoolQuery,
}));

jest.mock("../logger", () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
}));

jest.mock("./channels/inApp", () => ({ send: jest.fn() }));
jest.mock("./channels/push", () => ({ send: jest.fn(), sendToFollowers: jest.fn() }));
jest.mock("./channels/email", () => ({ send: jest.fn() }));

const pool = require("../db/pool");
const inAppChannel = require("./channels/inApp");
const pushChannel = require("./channels/push");
const emailChannel = require("./channels/email");
const notificationService = require("./notificationService");

describe("notificationService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPoolQuery.mockResolvedValue({ rows: [] });
  });

  test("sends in-app notification to wallet followers on project_update", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ wallet_address: "GAFOL" }] })
      .mockResolvedValueOnce({ rows: [] });

    inAppChannel.send.mockResolvedValue({ status: "sent", providerId: "inapp-1" });

    const result = await notificationService.send({
      type: "project_update",
      projectId: "proj-1",
      title: "Update",
      body: "New update",
    });

    expect(inAppChannel.send).toHaveBeenCalledWith(
      expect.objectContaining({ recipient: "GAFOL", title: "Update" }),
    );
  });

  test("sends monthly_digest to email subscribers", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ email: "sub@example.com" }] });

    emailChannel.send.mockResolvedValue({ status: "sent", providerId: "email-1" });

    const result = await notificationService.send({
      type: "monthly_digest",
      projectId: "proj-1",
      title: "Your Digest",
      body: "<h1>Digest</h1>",
      data: { text: "Digest text" },
    });

    expect(emailChannel.send).toHaveBeenCalledWith(
      expect.objectContaining({ recipient: "sub@example.com" }),
    );
  });

  test("skips push when wallet has no active device tokens", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ wallet_address: "GAFOL" }] })
      .mockResolvedValueOnce({ rows: [] });

    inAppChannel.send.mockResolvedValue({ status: "sent", providerId: "inapp-1" });

    const result = await notificationService.send({
      type: "milestone_reached",
      projectId: "proj-1",
      title: "Milestone!",
      body: "80% funded",
    });

    expect(pushChannel.send).not.toHaveBeenCalled();
    expect(inAppChannel.send).toHaveBeenCalled();
  });

  test("respects rate limiting", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ wallet_address: "GAFOL" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ "?column?": 1 }] });

    const result = await notificationService.send({
      type: "project_update",
      projectId: "proj-1",
      title: "Test",
      body: "Body",
    });

    expect(inAppChannel.send).not.toHaveBeenCalled();
  });

  test("sends verification_status to a single wallet", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] });

    inAppChannel.send.mockResolvedValue({ status: "sent", providerId: "inapp-1" });

    const result = await notificationService.send({
      type: "verification_status",
      walletAddress: "GAFOL",
      title: "Verified!",
      body: "Your project is verified",
    });

    expect(inAppChannel.send).toHaveBeenCalledWith(
      expect.objectContaining({ recipient: "GAFOL" }),
    );
  });
});
