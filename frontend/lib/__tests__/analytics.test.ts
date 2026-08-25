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

jest.mock("posthog-js", () => ({
  init: (...args: any[]) => mockInit(...args),
  capture: (...args: any[]) => mockCapture(...args),
  opt_in_capturing: (...args: any[]) => mockOptIn(...args),
  opt_out_capturing: (...args: any[]) => mockOptOut(...args),
  reset: (...args: any[]) => mockReset(...args),
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

  describe("consent gating", () => {
    it("does not init posthog if consent is undecided or denied", () => {
      consent.setConsent("undecided");
      analytics.initAnalytics();
      expect(mockInit).not.toHaveBeenCalled();

      consent.setConsent("denied");
      analytics.initAnalytics();
      expect(mockInit).not.toHaveBeenCalled();
    });

    it("inits posthog if consent is granted", () => {
      consent.setConsent("granted");
      analytics.initAnalytics();
      expect(mockInit).toHaveBeenCalledTimes(1);
    });

    it("scrubs data and opts out if consent changes to denied", () => {
      consent.setConsent("granted");
      analytics.initAnalytics();
      expect(mockInit).toHaveBeenCalledTimes(1);
      
      consent.setConsent("denied");
      expect(mockOptOut).toHaveBeenCalledWith();
      expect(mockReset).toHaveBeenCalledWith();
    });

    it("opts in and inits if consent changes to granted mid-session", () => {
      consent.setConsent("undecided");
      analytics.initAnalytics();
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
    it("strips donorAddress, transactionHash, and email from properties", () => {
      consent.setConsent("granted");
      analytics.initAnalytics();

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
  });
});
