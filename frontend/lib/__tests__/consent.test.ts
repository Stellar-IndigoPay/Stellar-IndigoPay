import { getConsent, setConsent, onConsentChange, getDefaultConsent } from "../consent";

describe("Consent Module", () => {
  let localStorageMock: { [key: string]: string } = {};

  beforeAll(() => {
    Object.defineProperty(window, "localStorage", {
      value: {
        getItem: jest.fn((key) => localStorageMock[key] || null),
        setItem: jest.fn((key, value) => {
          localStorageMock[key] = value.toString();
        }),
        removeItem: jest.fn((key) => {
          delete localStorageMock[key];
        }),
        clear: jest.fn(() => {
          localStorageMock = {};
        }),
      },
      writable: true,
    });
  });

  beforeEach(() => {
    localStorageMock = {};
    jest.clearAllMocks();
  });

  it("returns default consent when nothing is stored", () => {
    const consent = getConsent();
    expect(["undecided", "denied"]).toContain(consent);
  });

  it("persists consent choice", () => {
    setConsent("granted");
    expect(window.localStorage.setItem).toHaveBeenCalledWith("indigopay_analytics_consent", "granted");
    expect(getConsent()).toBe("granted");

    setConsent("denied");
    expect(window.localStorage.setItem).toHaveBeenCalledWith("indigopay_analytics_consent", "denied");
    expect(getConsent()).toBe("denied");
  });

  it("removes storage when set to undecided", () => {
    setConsent("granted");
    setConsent("undecided");
    expect(window.localStorage.removeItem).toHaveBeenCalledWith("indigopay_analytics_consent");
    expect(["undecided", "denied"]).toContain(getConsent());
  });

  it("notifies listeners on change", () => {
    const listener = jest.fn();
    const unsubscribe = onConsentChange(listener);

    setConsent("granted");
    expect(listener).toHaveBeenCalledWith("granted");

    setConsent("denied");
    expect(listener).toHaveBeenCalledWith("denied");

    unsubscribe();
    setConsent("granted");
    expect(listener).toHaveBeenCalledTimes(2); // shouldn't be called again
  });

  it("handles storage unavailability gracefully", () => {
    jest.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new Error("Storage disabled");
    });
    
    // Should default to denied if storage fails (e.g. private mode)
    expect(getConsent()).toBe("denied");
  });
});
