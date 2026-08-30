import {
  DEFAULT_DONATION_PRESETS,
  loadDonationPresets,
  normalizeDonationPresets,
  parseDonationAmount,
  presetIndexForAmount,
  presetIndexForShortcut,
} from "../lib/donationPresets";

beforeEach(() => {
  jest.clearAllMocks();
});

describe("donation preset normalization", () => {
  test("provides the four existing defaults", () => {
    expect(DEFAULT_DONATION_PRESETS).toEqual(["1", "5", "10", "50"]);
  });

  test("preserves valid stored values", () => {
    expect(normalizeDonationPresets(["2.5", "6", "12.5", "60"])).toEqual([
      "2.5",
      "6",
      "12.5",
      "60",
    ]);
  });

  test("fills missing and malformed slots independently", () => {
    expect(normalizeDonationPresets(["2", "nope", 0, Infinity])).toEqual([
      "2",
      "5",
      "10",
      "50",
    ]);
    expect(normalizeDonationPresets("not-an-array")).toEqual(
      DEFAULT_DONATION_PRESETS,
    );
  });

  test("rejects invalid donation amounts", () => {
    expect(parseDonationAmount("0.09")).toBeNull();
    expect(parseDonationAmount("NaN")).toBeNull();
    expect(parseDonationAmount({})).toBeNull();
    expect(parseDonationAmount("0.1")).toBe(0.1);
  });

  test("maps amounts to active preset slots", () => {
    expect(presetIndexForAmount("5.0", DEFAULT_DONATION_PRESETS)).toBe(1);
    expect(presetIndexForAmount("42", DEFAULT_DONATION_PRESETS)).toBe(-1);
  });

  test("maps Ctrl+1 through Ctrl+4 and rejects other keys", () => {
    expect(presetIndexForShortcut({ ctrlKey: true, key: "1" })).toBe(0);
    expect(presetIndexForShortcut({ ctrlKey: true, key: "2" })).toBe(1);
    expect(presetIndexForShortcut({ ctrlKey: true, key: "3" })).toBe(2);
    expect(presetIndexForShortcut({ ctrlKey: true, key: "4" })).toBe(3);
    expect(presetIndexForShortcut({ ctrlKey: false, key: "1" })).toBe(-1);
    expect(presetIndexForShortcut({ ctrlKey: true, key: "5" })).toBe(-1);
  });
});

describe("loadDonationPresets", () => {
  test("loads and normalizes chrome.storage.sync values", async () => {
    (chrome.storage.sync.get as jest.Mock).mockImplementation(
      (_keys: string[], callback: (items: Record<string, unknown>) => void) => {
        callback({ donationPresets: ["3", "7", "bad", "70"] });
      },
    );

    await expect(loadDonationPresets()).resolves.toEqual(["3", "7", "10", "70"]);
    expect(chrome.storage.sync.get).toHaveBeenCalledWith(
      ["donationPresets"],
      expect.any(Function),
    );
  });
});
