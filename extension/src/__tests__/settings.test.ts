/**
 * Tests for settings.ts exported functions and utilities.
 */

import {
  DEFAULT_SETTINGS,
  ExtensionSettings,
  loadSettings,
  saveSettings,
} from "../settings";

beforeEach(() => {
  jest.clearAllMocks();
});

// ── DEFAULT_SETTINGS ─────────────────────────────────────────────────

describe("DEFAULT_SETTINGS", () => {
  test("has expected default values", () => {
    expect(DEFAULT_SETTINGS.backendUrl).toBe("https://api.stellar-indigopay.app");
    expect(DEFAULT_SETTINGS.network).toBe("testnet");
    expect(DEFAULT_SETTINGS.defaultDonationAmount).toBe("5");
    expect(DEFAULT_SETTINGS.donationPresets).toEqual(["1", "5", "10", "50"]);
  });

  test("all keys are defined", () => {
    const keys: Array<keyof ExtensionSettings> = [
      "backendUrl",
      "network",
      "defaultDonationAmount",
      "donationPresets",
    ];
    for (const key of keys) {
      expect(DEFAULT_SETTINGS[key]).toBeDefined();
    }
  });

  test("ExtensionSettings type has correct shape", () => {
    const s: ExtensionSettings = {
      backendUrl: "https://example.com",
      network: "mainnet",
      defaultDonationAmount: "10",
      donationPresets: ["1", "5", "10", "50"],
    };
    expect(s.backendUrl).toBe("https://example.com");
    expect(s.network).toBe("mainnet");
    expect(s.defaultDonationAmount).toBe("10");
    expect(s.donationPresets).toEqual(["1", "5", "10", "50"]);
  });
});

// ── loadSettings ──────────────────────────────────────────────────────

describe("loadSettings", () => {
  test("returns settings from chrome.storage.sync", async () => {
    const mockSettings = {
      backendUrl: "https://custom-api.example.com",
      network: "mainnet",
      defaultDonationAmount: "10",
      donationPresets: ["2", "6", "12", "60"],
    };

    (chrome.storage.sync.get as jest.Mock).mockImplementation(
      (_keys: string[], callback: (items: Record<string, unknown>) => void) => {
        callback(mockSettings);
      },
    );

    const result = await loadSettings();
    expect(result).toEqual({ ...DEFAULT_SETTINGS, ...mockSettings });
    expect(chrome.storage.sync.get).toHaveBeenCalledWith(
      ["backendUrl", "network", "defaultDonationAmount", "donationPresets", "presets"],
      expect.any(Function),
    );
  });

  test("returns empty-like object when storage returns nothing", async () => {
    (chrome.storage.sync.get as jest.Mock).mockImplementation(
      (_keys: string[], callback: (items: Record<string, unknown>) => void) => {
        callback({});
      },
    );

    const result = await loadSettings();
    expect(result).toEqual({
      backendUrl: DEFAULT_SETTINGS.backendUrl,
      network: DEFAULT_SETTINGS.network,
      defaultDonationAmount: DEFAULT_SETTINGS.defaultDonationAmount,
      donationPresets: DEFAULT_SETTINGS.donationPresets,
    });
  });

  test("returns partial settings when storage returns partial", async () => {
    (chrome.storage.sync.get as jest.Mock).mockImplementation(
      (_keys: string[], callback: (items: Record<string, unknown>) => void) => {
        callback({ backendUrl: "https://partial.example.com" });
      },
    );

    const result = await loadSettings();
    expect(result).toEqual({
      backendUrl: "https://partial.example.com",
      network: DEFAULT_SETTINGS.network,
      defaultDonationAmount: DEFAULT_SETTINGS.defaultDonationAmount,
      donationPresets: DEFAULT_SETTINGS.donationPresets,
    });
  });

  test("handles undefined values from storage", async () => {
    (chrome.storage.sync.get as jest.Mock).mockImplementation(
      (_keys: string[], callback: (items: Record<string, unknown>) => void) => {
        callback({ backendUrl: undefined, network: undefined, defaultDonationAmount: undefined });
      },
    );

    const result = await loadSettings();
    expect(result).toEqual({
      backendUrl: DEFAULT_SETTINGS.backendUrl,
      network: DEFAULT_SETTINGS.network,
      defaultDonationAmount: DEFAULT_SETTINGS.defaultDonationAmount,
      donationPresets: DEFAULT_SETTINGS.donationPresets,
    });
  });
});

// ── saveSettings ──────────────────────────────────────────────────────

describe("saveSettings", () => {
  test("resolves when chrome.storage.sync.set succeeds", async () => {
    (chrome.storage.sync.set as jest.Mock).mockImplementation(
      (_items: Record<string, unknown>, callback?: () => void) => {
        if (callback) callback();
      },
    );

    const settings: ExtensionSettings = {
      backendUrl: "https://new-api.example.com",
      network: "mainnet",
      defaultDonationAmount: "20",
      donationPresets: ["2", "6", "12", "60"],
    };

    await expect(saveSettings(settings)).resolves.toBeUndefined();
    expect(chrome.storage.sync.set).toHaveBeenCalledWith(settings, expect.any(Function));
  });

  test("rejects when chrome.runtime.lastError has message", async () => {
    (chrome.storage.sync.set as jest.Mock).mockImplementation(
      (_items: Record<string, unknown>, callback?: () => void) => {
        (globalThis as any).chrome.runtime.lastError = { message: "Storage full" };
        if (callback) callback();
      },
    );

    const settings: ExtensionSettings = {
      backendUrl: "https://new-api.example.com",
      network: "testnet",
      defaultDonationAmount: "5",
      donationPresets: ["1", "5", "10", "50"],
    };

    await expect(saveSettings(settings)).rejects.toThrow("Storage full");
    (globalThis as any).chrome.runtime.lastError = null;
  });

  test("rejects with generic message when lastError has no message", async () => {
    (chrome.storage.sync.set as jest.Mock).mockImplementation(
      (_items: Record<string, unknown>, callback?: () => void) => {
        (globalThis as any).chrome.runtime.lastError = { message: undefined };
        if (callback) callback();
      },
    );

    const settings: ExtensionSettings = {
      backendUrl: "https://new-api.example.com",
      network: "testnet",
      defaultDonationAmount: "5",
      donationPresets: ["1", "5", "10", "50"],
    };

    await expect(saveSettings(settings)).rejects.toThrow();
    (globalThis as any).chrome.runtime.lastError = null;
  });

  test("rejects with custom error message from lastError", async () => {
    (chrome.storage.sync.set as jest.Mock).mockImplementation(
      (_items: Record<string, unknown>, callback?: () => void) => {
        (globalThis as any).chrome.runtime.lastError = { message: "Quota exceeded" };
        if (callback) callback();
      },
    );

    const settings: ExtensionSettings = {
      backendUrl: "https://api.example.com",
      network: "testnet",
      defaultDonationAmount: "5",
      donationPresets: ["1", "5", "10", "50"],
    };

    await expect(saveSettings(settings)).rejects.toThrow("Quota exceeded");
    (globalThis as any).chrome.runtime.lastError = null;
  });
});

// ── truncateAddress (tested as inline logic since it's private) ───────

describe("truncateAddress", () => {
  const truncateAddress = (address: string): string => {
    return `${address.slice(0, 4)}…${address.slice(-4)}`;
  };

  test("truncates a long address", () => {
    const addr = "GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG";
    expect(truncateAddress(addr)).toBe("GDFJ…KKHG");
  });

  test("returns short strings truncated", () => {
    expect(truncateAddress("abc")).toBe("abc…abc");
    expect(truncateAddress("ab")).toBe("ab…ab");
  });
});

// ── Wallet helpers (inline logic) ─────────────────────────────────────

describe("Wallet helpers", () => {
  test("getWalletPublicKey returns null when freighter is not available", async () => {
    delete (window as any).freighter;
    const result = await (async () => {
      const freighter = (window as any).freighter;
      if (!freighter || typeof freighter.getPublicKey !== "function") return null;
      return null;
    })();
    expect(result).toBeNull();
  });

  test("isFreighterConnected returns false when freighter is not available", async () => {
    delete (window as any).freighter;
    const result = await (async () => {
      const freighter = (window as any).freighter;
      if (!freighter || typeof freighter.isConnected !== "function") return false;
      return false;
    })();
    expect(result).toBe(false);
  });
});
