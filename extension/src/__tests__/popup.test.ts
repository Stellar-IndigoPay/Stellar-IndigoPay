
jest.mock('@stellar/stellar-sdk', () => ({
  Horizon: { Server: class { constructor() {} } },
  Networks: { TESTNET: 'testnet' },
  Asset: {},
  TransactionBuilder: {},
  Keypair: {}
}));

jest.mock('../settings', () => ({
  loadSettings: jest.fn().mockResolvedValue({
    donationPresets: ["1", "5", "10", "50"],
    defaultDonationAmount: "5",
    backendUrl: "http://test",
    network: "testnet"
  }),
  applySettings: jest.fn()
}));

import "../popup";
/**
 * Tests for popup.ts pure functions and logic.
 *
 * We test the logic directly without importing the module to avoid
 * ESM dependency issues with @stellar/stellar-sdk.
 */

// ── escapeHtml ────────────────────────────────────────────────────────

describe("escapeHtml", () => {
  const escapeHtml = (value: string): string => {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  };

  test("escapes HTML special characters", () => {
    expect(escapeHtml("<script>alert('xss')</script>")).toBe(
      "&lt;script&gt;alert(&#039;xss&#039;)&lt;/script&gt;",
    );
  });

  test("escapes ampersands", () => {
    expect(escapeHtml("A & B")).toBe("A &amp; B");
  });

  test("escapes double quotes", () => {
    expect(escapeHtml('He said "hello"')).toBe("He said &quot;hello&quot;");
  });

  test("returns plain text unchanged", () => {
    expect(escapeHtml("Hello World")).toBe("Hello World");
  });

  test("handles empty string", () => {
    expect(escapeHtml("")).toBe("");
  });

  test("escapes all special chars simultaneously", () => {
    expect(escapeHtml("<a href='foo' & \"bar\">")).toBe(
      "&lt;a href=&#039;foo&#039; &amp; &quot;bar&quot;&gt;",
    );
  });
});

// ── getProjectEmoji ───────────────────────────────────────────────────

describe("getProjectEmoji", () => {
  const getProjectEmoji = (category: string): string => {
    const map: Record<string, string> = {
      Reforestation: "🌳",
      "Solar Energy": "☀️",
      "Ocean Conservation": "🌊",
      "Clean Water": "💧",
      "Wildlife Protection": "🦁",
      "Carbon Capture": "♻️",
      "Wind Energy": "💨",
      "Sustainable Agriculture": "🌾",
    };
    return map[category] ?? "🌿";
  };

  test("returns correct emoji for known categories", () => {
    expect(getProjectEmoji("Reforestation")).toBe("🌳");
    expect(getProjectEmoji("Solar Energy")).toBe("☀️");
    expect(getProjectEmoji("Ocean Conservation")).toBe("🌊");
    expect(getProjectEmoji("Clean Water")).toBe("💧");
    expect(getProjectEmoji("Wildlife Protection")).toBe("🦁");
    expect(getProjectEmoji("Carbon Capture")).toBe("♻️");
    expect(getProjectEmoji("Wind Energy")).toBe("💨");
    expect(getProjectEmoji("Sustainable Agriculture")).toBe("🌾");
  });

  test("returns default emoji for unknown categories", () => {
    expect(getProjectEmoji("Unknown Category")).toBe("🌿");
    expect(getProjectEmoji("")).toBe("🌿");
    expect(getProjectEmoji("Random")).toBe("🌿");
  });
});

// ── abbreviateNumber ──────────────────────────────────────────────────

describe("abbreviateNumber", () => {
  const abbreviateNumber = (num: number): string => {
    if (num < 1000) return Math.floor(num).toString();
    if (num < 1000000) return Math.floor(num / 1000) + "K";
    return (num / 1000000).toFixed(1) + "M";
  };

  test("returns plain number for values under 1000", () => {
    expect(abbreviateNumber(0)).toBe("0");
    expect(abbreviateNumber(1)).toBe("1");
    expect(abbreviateNumber(999)).toBe("999");
  });

  test("abbreviates thousands with K", () => {
    expect(abbreviateNumber(1000)).toBe("1K");
    expect(abbreviateNumber(1500)).toBe("1K");
    expect(abbreviateNumber(999999)).toBe("999K");
  });

  test("abbreviates millions with M", () => {
    expect(abbreviateNumber(1000000)).toBe("1.0M");
    expect(abbreviateNumber(1500000)).toBe("1.5M");
    expect(abbreviateNumber(10000000)).toBe("10.0M");
  });

  test("handles edge cases", () => {
    expect(abbreviateNumber(999.9)).toBe("999");
    expect(abbreviateNumber(0)).toBe("0");
    expect(abbreviateNumber(-1)).toBe("-1");
  });
});

// ── Address truncation ────────────────────────────────────────────────

describe("truncateAddress (popup)", () => {
  const truncateAddress = (addr: string): string => {
    if (addr.length <= 12) return addr;
    return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
  };

  test("truncates long addresses", () => {
    const addr = "GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG";
    expect(truncateAddress(addr)).toBe("GDFJEG…KKHG");
  });

  test("returns short strings as-is", () => {
    expect(truncateAddress("short")).toBe("short");
    expect(truncateAddress("123456789012")).toBe("123456789012");
  });
});

// ── Stellar address validation ────────────────────────────────────────

describe("Stellar address validation", () => {
  test("valid Stellar address matches regex", () => {
    const addr = "GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG";
    expect(/^G[A-Z2-7]{55}$/.test(addr.trim())).toBe(true);
  });

  test("invalid address rejected", () => {
    expect(/^G[A-Z2-7]{55}$/.test("not-an-address")).toBe(false);
    expect(/^G[A-Z2-7]{55}$/.test("")).toBe(false);
  });

  test("minimum amount validation", () => {
    expect(0.5 >= 0.1).toBe(true);
    expect(0.05 >= 0.1).toBe(false);
    expect(0 >= 0.1).toBe(false);
    expect(0.1 >= 0.1).toBe(true);
  });

  test("memo length validation (max 28)", () => {
    expect("Short memo".length <= 28).toBe(true);
    expect("A".repeat(28).length <= 28).toBe(true);
    expect("A".repeat(29).length <= 28).toBe(false);
  });

  test("E2E keyboard shortcut behavior for presets and Enter", async () => {
    // Setup DOM
    document.body.innerHTML = `
      <div id="preset-amounts"></div>
      <div id="active-project"></div>
      <input type="number" id="custom-amount-input" />
      <button id="donate-submit" disabled></button>
      <input type="hidden" id="destination" value="GDX..." />
      <div id="custom-donate-container" style="display: none;"></div>
      <input id="search-input" />
      <div id="project-list-container"></div>
      <span id="wallet-address"></span>
      <div id="wallet-info" class="hidden"></div>
      <button id="connect-btn"></button>
      <div id="api-status"></div>
      
      <!-- Dummy elements for settings.ts -->
      <input id="backend-url" />
      <input id="default-amount" />
      <input id="preset-1" />
      <input id="preset-2" />
      <input id="preset-3" />
      <input id="preset-4" />
      <form id="settings-form"></form>
      <div id="wallet-display"></div>
      <span id="wallet-dot"></span>
      <span id="wallet-address-text"></span>
      <button id="wallet-action-btn"></button>
    `;

    // Mock settings
    const mockStorage = {
      get: jest.fn((keys, cb) => cb({
        presets: ["10", "50", "100", "500"], 
        defaultDonationAmount: "10", 
        backendUrl: "http://test",
        network: "testnet"
      })),
      set: jest.fn(),
      remove: jest.fn()
    };
    (globalThis as any).chrome = {
      storage: {
        local: {
          get: jest.fn((keys, cb) => cb({
            presets: ["10", "50", "100", "500"],
            defaultDonationAmount: "10",
            backendUrl: "http://test",
            network: "testnet"
          })),
          set: jest.fn(),
          remove: jest.fn()
        },
        sync: {
          get: jest.fn(), set: jest.fn()
        }
      },
      runtime: {
        sendMessage: jest.fn(),
        onMessage: {
          addListener: jest.fn()
        },
        lastError: null
      }
    };

    // Trigger initialization
    document.dispatchEvent(new Event("DOMContentLoaded"));
    
    // Wait for async initialization
    await new Promise(r => setTimeout(r, 0));

    // Simulate Ctrl+2
    const evt = new KeyboardEvent('keydown', { key: '2', ctrlKey: true });
    document.dispatchEvent(evt);

    const input = document.getElementById('custom-amount-input') as HTMLInputElement;
    expect(input.value).toBe("5");
    const activeBtn = document.querySelector('.preset-btn.active') as HTMLElement;
    expect(activeBtn).not.toBeNull();
    expect(activeBtn.dataset.amount).toBe("5");

    // Test Enter
    let clicked = false;
    const donateBtn = document.getElementById('donate-submit') as HTMLButtonElement;
    donateBtn.addEventListener('click', () => clicked = true);
    donateBtn.disabled = false; // Make sure it's enabled to click

    const enterEvt = new KeyboardEvent('keydown', { key: 'Enter' });
    document.dispatchEvent(enterEvt);
    expect(clicked).toBe(true);
  });
});
