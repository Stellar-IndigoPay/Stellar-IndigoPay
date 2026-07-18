"use strict";

jest.mock("../logger", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock("./metrics", () => ({
  registry: { registerMetric: jest.fn() },
  metrics: {
    pushSentTotal: { inc: jest.fn() },
    pushLatencySeconds: { observe: jest.fn() },
  },
}));
jest.mock("./circuitBreaker", () => {
  const { CircuitBreaker, STATES } = jest.requireActual("./circuitBreaker");
  return { CircuitBreaker, STATES };
});

let mockApnSend = jest.fn();
jest.mock("@parse/node-apn", () => {
  return {
    Provider: jest.fn().mockImplementation(() => ({
      send: (notification, deviceToken) => mockApnSend(notification, deviceToken),
      shutdown: jest.fn(),
    })),
    Notification: jest.fn().mockImplementation(() => ({
      expiry: 0, badge: 1, sound: "", alert: {}, payload: {}, topic: "", priority: 10,
    })),
  };
});

let mockExpoSend;
jest.mock("expo-server-sdk", () => {
  mockExpoSend = jest.fn();
  return {
    Expo: class {
      static isExpoPushToken(t) { return t && t.startsWith("ExponentPushToken["); }
      sendPushNotificationsAsync(m) { return mockExpoSend(m); }
    },
  };
});

global.fetch = jest.fn();

let ApnsProvider, FcmProvider, ExpoProvider, selectProvider, sendViaProvider;

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  global.fetch = jest.fn();
  process.env.APNS_KEY_ID = "TESTKEY";
  process.env.APNS_TEAM_ID = "TESTTEAM";
  process.env.APNS_PRIVATE_KEY_PATH = "/fake/key.p8";
  process.env.APNS_BUNDLE_ID = "com.test.app";
  process.env.FCM_SERVER_KEY = "fcm-test-server-key";
  ({ ApnsProvider, FcmProvider, ExpoProvider, selectProvider, sendViaProvider } = require("./pushProviders"));
});

afterEach(() => {
  ["APNS_KEY_ID", "APNS_TEAM_ID", "APNS_PRIVATE_KEY_PATH", "APNS_BUNDLE_ID", "FCM_SERVER_KEY"]
    .forEach((k) => delete process.env[k]);
});

describe("ApnsProvider", () => {
  const VALID_TOKEN = "a".repeat(64);

  test("validateToken true for 64-char hex token", () => {
    expect(new ApnsProvider().validateToken(VALID_TOKEN)).toBe(true);
  });
  test("validateToken false for short token", () => {
    expect(new ApnsProvider().validateToken("short")).toBe(false);
  });
  test("providerName is apns", () => {
    expect(new ApnsProvider().providerName).toBe("apns");
  });
  test("send returns success when APNs reports sent", async () => {
    mockApnSend = jest.fn().mockResolvedValue({ sent: [{ device: VALID_TOKEN }], failed: [] });
    const { ApnsProvider: A } = require("./pushProviders");
    const result = await new A().send(VALID_TOKEN, { title: "T", body: "B" });
    expect(result.success).toBe(true);
    expect(result.providerMessageId).toBe(VALID_TOKEN);
  });
  test("send returns unregistered true on 410 Unregistered", async () => {
    mockApnSend = jest.fn().mockResolvedValue({
      sent: [],
      failed: [{ status: "410", response: { reason: "Unregistered" } }],
    });
    const { ApnsProvider: A } = require("./pushProviders");
    const result = await new A().send(VALID_TOKEN, { title: "T", body: "B" });
    expect(result.success).toBe(false);
    expect(result.unregistered).toBe(true);
  });
  test("send throws on non-unregistered APNs error", async () => {
    mockApnSend = jest.fn().mockResolvedValue({
      sent: [],
      failed: [{ status: "400", response: { reason: "BadDeviceToken" } }],
    });
    const { ApnsProvider: A } = require("./pushProviders");
    await expect(new A().send(VALID_TOKEN, { title: "T", body: "B" }))
      .rejects.toThrow("APNs error: BadDeviceToken");
  });
  test("send throws when APNS_KEY_ID is not set", async () => {
    delete process.env.APNS_KEY_ID;
    jest.resetModules();
    const { ApnsProvider: A } = require("./pushProviders");
    await expect(new A().send(VALID_TOKEN, { title: "T", body: "B" })).rejects.toThrow();
  });
});

describe("FcmProvider", () => {
  const FCM_TOKEN = "fcm_" + "x".repeat(150);

  test("validateToken true for long token", () => {
    expect(new FcmProvider().validateToken(FCM_TOKEN)).toBe(true);
  });
  test("validateToken false for short token", () => {
    expect(new FcmProvider().validateToken("short")).toBe(false);
  });
  test("providerName is fcm", () => {
    expect(new FcmProvider().providerName).toBe("fcm");
  });
  test("send returns success on FCM success 1", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: 1, results: [{ message_id: "msg123" }] }),
    });
    const result = await new FcmProvider().send(FCM_TOKEN, { title: "T", body: "B" });
    expect(result.success).toBe(true);
    expect(result.providerMessageId).toBe("msg123");
  });
  test("send returns unregistered true on NotRegistered", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: 0, results: [{ error: "NotRegistered" }] }),
    });
    const result = await new FcmProvider().send(FCM_TOKEN, { title: "T", body: "B" });
    expect(result.success).toBe(false);
    expect(result.unregistered).toBe(true);
  });
  test("send throws on HTTP error", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "err" });
    await expect(new FcmProvider().send(FCM_TOKEN, { title: "T", body: "B" }))
      .rejects.toThrow("FCM HTTP 500");
  });
  test("send throws when FCM_SERVER_KEY not set", async () => {
    delete process.env.FCM_SERVER_KEY;
    jest.resetModules();
    const { FcmProvider: F } = require("./pushProviders");
    await expect(new F().send(FCM_TOKEN, { title: "T", body: "B" })).rejects.toThrow("not configured");
  });
});

describe("ExpoProvider", () => {
  const EXPO_TOKEN = "ExponentPushToken[valid-token]";

  test("validateToken true for expo token", () => {
    expect(new ExpoProvider().validateToken(EXPO_TOKEN)).toBe(true);
  });
  test("validateToken false for non-expo token", () => {
    expect(new ExpoProvider().validateToken("not-expo")).toBe(false);
  });
  test("providerName is expo", () => {
    expect(new ExpoProvider().providerName).toBe("expo");
  });
  test("send returns success on ok ticket", async () => {
    mockExpoSend = jest.fn().mockResolvedValue([{ status: "ok", id: "expo-ticket-1" }]);
    const result = await new ExpoProvider().send(EXPO_TOKEN, { title: "T", body: "B" });
    expect(result.success).toBe(true);
    expect(result.providerMessageId).toBe("expo-ticket-1");
  });
  test("send returns unregistered true on DeviceNotRegistered", async () => {
    mockExpoSend = jest.fn().mockResolvedValue([{
      status: "error",
      details: { error: "DeviceNotRegistered" },
    }]);
    const result = await new ExpoProvider().send(EXPO_TOKEN, { title: "T", body: "B" });
    expect(result.unregistered).toBe(true);
  });
  test("send returns error for non-expo token", async () => {
    const result = await new ExpoProvider().send("not-expo", { title: "T", body: "B" });
    expect(result.success).toBe(false);
  });
});

describe("selectProvider", () => {
  test("ios -> apns", () => { expect(selectProvider("ios").primary.providerName).toBe("apns"); });
  test("android -> fcm", () => { expect(selectProvider("android").primary.providerName).toBe("fcm"); });
  test("web -> expo", () => { expect(selectProvider("web").primary.providerName).toBe("expo"); });
  test("null -> expo", () => { expect(selectProvider(null).primary.providerName).toBe("expo"); });
  test("preference expo overrides ios", () => { expect(selectProvider("ios", "expo").primary.providerName).toBe("expo"); });
  test("preference apns overrides android", () => { expect(selectProvider("android", "apns").primary.providerName).toBe("apns"); });
  test("fallback is always expo", () => { expect(selectProvider("ios").fallback.providerName).toBe("expo"); });
});

describe("sendViaProvider", () => {
  const T = "ExponentPushToken[abc]";

  test("delivered outcome on success", async () => {
    mockExpoSend = jest.fn().mockResolvedValue([{ status: "ok", id: "t1" }]);
    const r = await sendViaProvider(T, null, "auto", { title: "T", body: "B" });
    expect(r.success).toBe(true);
    expect(r.outcome).toBe("delivered");
    expect(r.provider).toBe("expo");
  });
  test("unregistered outcome on stale token", async () => {
    mockExpoSend = jest.fn().mockResolvedValue([{ status: "error", details: { error: "DeviceNotRegistered" } }]);
    const r = await sendViaProvider(T, null, "auto", { title: "T", body: "B" });
    expect(r.outcome).toBe("unregistered");
    expect(r.unregistered).toBe(true);
  });
  test("increments Prometheus counter on delivery", async () => {
    const { metrics: { pushSentTotal } } = require("./metrics");
    mockExpoSend = jest.fn().mockResolvedValue([{ status: "ok", id: "t2" }]);
    await sendViaProvider(T, null, "auto", { title: "T", body: "B" });
    expect(pushSentTotal.inc).toHaveBeenCalledWith({ provider: "expo", outcome: "delivered" });
  });
  test("failed outcome when provider fails", async () => {
    mockExpoSend = jest.fn().mockRejectedValue(new Error("network error"));
    const r = await sendViaProvider(T, null, "expo", { title: "T", body: "B" });
    expect(r.success).toBe(false);
    expect(r.outcome).toBe("failed");
  });
});
