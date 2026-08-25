/**
 * lib/__tests__/analytics.test.ts
 *
 * Unit tests for the analytics module. posthog-js is mocked so that no
 * real API calls are made during tests and the NODE_ENV guard prevents
 * accidental capture.
 */

const mockCapture = jest.fn();
const mockInit = jest.fn();
const mockOptIn = jest.fn();
const mockOptOut = jest.fn();
const mockReset = jest.fn();

const mockPostHog = {
  init: (...args: any[]) => mockInit(...args),
  capture: (...args: any[]) => mockCapture(...args),
  set_config: (...args: any[]) => mockSetConfig(...args),
};

jest.mock("posthog-js", () => ({
  __esModule: true,
  default: mockPostHog,
}));

jest.mock("../consent", () => {
  let consentState = "undecided";
  let listeners: any[] = [];
  return {
    getConsent: jest.fn(() => consentState),
    setConsent: jest.fn((newState) => {
      consentState = newState;
      listeners.forEach((l) => l(newState));
    }),
    onConsentChange: jest.fn((l) => {
      listeners.push(l);
      return () => {
        listeners = listeners.filter((fn) => fn !== l);
      };
    }),
    // helper to reset in tests
    __resetConsentMock: () => {
      consentState = "undecided";
      listeners = [];
    },
  };
});

describe("analytics module", () => {
  const env = process.env;
  let analytics: any;
  let consent: any;

  beforeEach(() => {
    jest.isolateModules(() => {
      jest.clearAllMocks();
      process.env = { ...env };
      (process.env as Record<string, string>).NODE_ENV = "production";
      (process.env as Record<string, string>).NEXT_PUBLIC_POSTHOG_KEY = "test-key";
      consent = require("../consent");
      consent.__resetConsentMock();
      analytics = require("../analytics");
    });
  });

  afterAll(() => {
    process.env = env;
  });

  describe("environment gating", () => {
    it("does not init posthog in development", async () => {
      (process.env as Record<string, string>).NODE_ENV = "development";
      const { initAnalytics } = require("../analytics");
      await initAnalytics();
      expect(mockInit).not.toHaveBeenCalled();
    });

    it("inits posthog if consent is granted", () => {
      consent.setConsent("granted");
      analytics.initAnalytics();
      expect(mockInit).toHaveBeenCalledTimes(1);
    });

    it("does nothing when window is undefined (SSR)", async () => {
      (process.env as Record<string, string>).NODE_ENV = "production";
      const windowSpy = jest
        .spyOn(global, "window" as any, "get")
        .mockReturnValue(undefined);
      const { initAnalytics } = require("../analytics");
      await expect(initAnalytics()).resolves.not.toThrow();
      expect(mockInit).not.toHaveBeenCalled();

      consent.setConsent("granted");
      expect(mockInit).toHaveBeenCalledTimes(1);
    });

    it("does not capture events unless consent is granted and initialized", () => {
      consent.setConsent("undecided");
      analytics.initAnalytics();
      analytics.trackEvent("test_event");
      expect(mockCapture).not.toHaveBeenCalled();

      consent.setConsent("granted");
      // it should have been init by the listener now
      analytics.trackEvent("test_event");
      expect(mockCapture).toHaveBeenCalledTimes(1);
    });
  });

  describe("PII stripping via sanitize_properties", () => {
    it("strips donorAddress, transactionHash, and email from properties", async () => {
      (process.env as Record<string, string>).NODE_ENV = "production";
      (process.env as Record<string, string>).NEXT_PUBLIC_POSTHOG_KEY = "test-key";
      const { initAnalytics } = require("../analytics");
      await initAnalytics();

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

    it("buckets amountXLM into ranges", async () => {
      (process.env as Record<string, string>).NODE_ENV = "production";
      (process.env as Record<string, string>).NEXT_PUBLIC_POSTHOG_KEY = "test-key";
      const { initAnalytics } = require("../analytics");
      await initAnalytics();

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
    it("sets persistence to cookie when consent is true", async () => {
      (process.env as Record<string, string>).NODE_ENV = "production";
      (process.env as Record<string, string>).NEXT_PUBLIC_POSTHOG_KEY = "test-key";
      const { setAnalyticsConsent, initAnalytics } = require("../analytics");
      await initAnalytics();
      setAnalyticsConsent(true);
      expect(mockSetConfig).toHaveBeenCalledWith({ persistence: "cookie" });
    });

    it("sets persistence to memory when consent is false", async () => {
      (process.env as Record<string, string>).NODE_ENV = "production";
      (process.env as Record<string, string>).NEXT_PUBLIC_POSTHOG_KEY = "test-key";
      const { setAnalyticsConsent, initAnalytics } = require("../analytics");
      await initAnalytics();
      setAnalyticsConsent(false);
      expect(mockSetConfig).toHaveBeenCalledWith({ persistence: "memory" });
    });
  });
});
