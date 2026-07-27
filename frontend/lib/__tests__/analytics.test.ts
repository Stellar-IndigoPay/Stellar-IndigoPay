/**
 * lib/__tests__/analytics.test.ts
 *
 * Unit tests for the analytics module. posthog-js is mocked so that no
 * real API calls are made during tests and the NODE_ENV guard prevents
 * accidental capture.
 */

const mockCapture = jest.fn();
const mockInit = jest.fn();
const mockSetConfig = jest.fn();

jest.mock("posthog-js", () => ({
  init: (...args: any[]) => mockInit(...args),
  capture: (...args: any[]) => mockCapture(...args),
  set_config: (...args: any[]) => mockSetConfig(...args),
}));

describe("analytics module", () => {
  const env = process.env;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env = { ...env };
    delete (process.env as Record<string, string>).NODE_ENV;
  });

  afterAll(() => {
    process.env = env;
  });

  describe("environment gating", () => {
    it("does not init posthog in development", () => {
      (process.env as Record<string, string>).NODE_ENV = "development";
      const { initAnalytics } = require("../analytics");
      initAnalytics();
      expect(mockInit).not.toHaveBeenCalled();
    });

    it("does not capture events in development", () => {
      (process.env as Record<string, string>).NODE_ENV = "development";
      const { trackEvent } = require("../analytics");
      trackEvent("test_event", { foo: "bar" });
      expect(mockCapture).not.toHaveBeenCalled();
    });

    it("does nothing when window is undefined (SSR)", () => {
      (process.env as Record<string, string>).NODE_ENV = "production";
      const windowSpy = jest
        .spyOn(global, "window" as any, "get")
        .mockReturnValue(undefined);
      const { initAnalytics } = require("../analytics");
      expect(() => initAnalytics()).not.toThrow();
      expect(mockInit).not.toHaveBeenCalled();
      windowSpy.mockRestore();
    });
  });

  describe("PII stripping via sanitize_properties", () => {
    it("strips donorAddress, transactionHash, and email from properties", () => {
      (process.env as Record<string, string>).NODE_ENV = "production";
      const { initAnalytics } = require("../analytics");
      initAnalytics();

      const sanitizeFn = mockInit.mock.calls[0][1].sanitize_properties;

      const result = sanitizeFn({
        donorAddress: "GCUZ...ABCD",
        transactionHash: "abc123def456",
        email: "donor@example.com",
        projectId: "proj-1",
        currency: "XLM",
      });

      expect(result.donorAddress).toBeUndefined();
      expect(result.transactionHash).toBeUndefined();
      expect(result.email).toBeUndefined();
      expect(result.projectId).toBe("proj-1");
      expect(result.currency).toBe("XLM");
    });

    it("buckets amountXLM into ranges", () => {
      (process.env as Record<string, string>).NODE_ENV = "production";
      const { initAnalytics } = require("../analytics");
      initAnalytics();

      const sanitizeFn = mockInit.mock.calls[0][1].sanitize_properties;

      expect(sanitizeFn({ amountXLM: "5" }).amountXLM).toBe("0-10");
      expect(sanitizeFn({ amountXLM: "25" }).amountXLM).toBe("11-50");
      expect(sanitizeFn({ amountXLM: "75" }).amountXLM).toBe("51-100");
      expect(sanitizeFn({ amountXLM: "200" }).amountXLM).toBe("101-500");
      expect(sanitizeFn({ amountXLM: "600" }).amountXLM).toBe("500+");
    });
  });

  describe("bucketAmount", () => {
    it("returns correct range for various amounts", () => {
      const { bucketAmount } = require("../analytics");
      expect(bucketAmount("0")).toBe("0-10");
      expect(bucketAmount("10")).toBe("0-10");
      expect(bucketAmount("11")).toBe("11-50");
      expect(bucketAmount("50")).toBe("11-50");
      expect(bucketAmount("51")).toBe("51-100");
      expect(bucketAmount("100")).toBe("51-100");
      expect(bucketAmount("101")).toBe("101-500");
      expect(bucketAmount("500")).toBe("101-500");
      expect(bucketAmount("501")).toBe("500+");
      expect(bucketAmount("9999")).toBe("500+");
    });
  });

  describe("setAnalyticsConsent", () => {
    it("sets persistence to cookie when consent is true", () => {
      const { setAnalyticsConsent } = require("../analytics");
      setAnalyticsConsent(true);
      expect(mockSetConfig).toHaveBeenCalledWith({ persistence: "cookie" });
    });

    it("sets persistence to memory when consent is false", () => {
      const { setAnalyticsConsent } = require("../analytics");
      setAnalyticsConsent(false);
      expect(mockSetConfig).toHaveBeenCalledWith({ persistence: "memory" });
    });
  });
});
