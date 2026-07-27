/**
 * Tests for the enhanced content-script logic.
 *
 * Imports from content-script-logic.ts (pure module with no side effects)
 * instead of content-script.ts (entry point with auto-init side effects).
 *
 * Covers:
 * - Address regex detection against valid/invalid addresses
 * - DOM injection doesn't duplicate buttons on re-scan
 * - Overlay open/close lifecycle
 * - Mock chrome.runtime.sendMessage for project lookup
 */

// Chrome API is mocked via jest.setup.js (setupFiles)

import {
  STELLAR_ADDRESS_RE,
  findAddressTextNodes,
  extractAddresses,
  injectDonateButton,
  scanAndInject,
} from "../content-script-logic";

// Mock the overlay module
jest.mock("../inject/donate-overlay", () => ({
  mountDonateOverlay: jest.fn(() => jest.fn()),
}));

import { mountDonateOverlay } from "../inject/donate-overlay";

beforeEach(() => {
  document.body.innerHTML = "";
  jest.clearAllMocks();
});

// ── 1. Address regex detection ───────────────────────────────────────

describe("STELLAR_ADDRESS_RE", () => {
  test("matches valid Stellar addresses", () => {
    const validAddresses = [
      "GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG",
      "GBWARNKVFUYBSD6ZBJRLKXFWOZRXB5TIICONCHYQNYFF2J2IRQM4R2KR",
    ];

    for (const addr of validAddresses) {
      STELLAR_ADDRESS_RE.lastIndex = 0;
      expect(addr.length).toBe(56); // G + 55 chars
      expect(STELLAR_ADDRESS_RE.test(addr)).toBe(true);
    }
  });

  test("rejects invalid address patterns", () => {
    const invalid = [
      "",
      "G123",
      "not-a-stellar-address",
      "G 123456789012345678901234567890123456789012345678901234567",
      "gDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG",
    ];

    for (const addr of invalid) {
      STELLAR_ADDRESS_RE.lastIndex = 0;
      expect(STELLAR_ADDRESS_RE.test(addr)).toBe(false);
    }
  });

  test("rejects addresses that are too short or too long", () => {
    STELLAR_ADDRESS_RE.lastIndex = 0;
    expect(STELLAR_ADDRESS_RE.test("G" + "A".repeat(54))).toBe(false); // 55 chars

    STELLAR_ADDRESS_RE.lastIndex = 0;
    expect(STELLAR_ADDRESS_RE.test("G" + "A".repeat(56))).toBe(false); // 57 chars
  });

  test("extracts addresses from mixed text", () => {
    const text =
      "Send XLM to GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG for donations";
    STELLAR_ADDRESS_RE.lastIndex = 0;
    const matches = text.match(STELLAR_ADDRESS_RE);
    expect(matches).toHaveLength(1);
    expect(matches![0]).toBe(
      "GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG",
    );
  });

  test("finds multiple addresses in text", () => {
    const text = `A: GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG
                  B: GBWARNKVFUYBSD6ZBJRLKXFWOZRXB5TIICONCHYQNYFF2J2IRQM4R2KR
                  C: G123`;
    STELLAR_ADDRESS_RE.lastIndex = 0;
    const matches = text.match(STELLAR_ADDRESS_RE);
    expect(matches).toHaveLength(2);
  });
});

// ── 2. extractAddresses ──────────────────────────────────────────────

describe("extractAddresses", () => {
  test("returns deduplicated addresses from a text node", () => {
    const textNode = document.createTextNode(
      "GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG and again GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG",
    );
    const result = extractAddresses(textNode);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(
      "GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG",
    );
  });

  test("returns empty array for text without addresses", () => {
    const textNode = document.createTextNode("No addresses here!");
    const result = extractAddresses(textNode);
    expect(result).toHaveLength(0);
  });
});

// ── 3. findAddressTextNodes ──────────────────────────────────────────

describe("findAddressTextNodes", () => {
  test("finds text nodes containing Stellar addresses", () => {
    document.body.innerHTML = `
      <p>Send to GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG today!</p>
    `;
    const nodes = findAddressTextNodes();
    expect(nodes.length).toBeGreaterThanOrEqual(1);
    expect(nodes[0].textContent).toContain(
      "GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG",
    );
  });

  test("skips script and style elements", () => {
    document.body.innerHTML = `
      <div>
        <script>var addr = "GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG";</script>
        <style>.bg { background: #fff; }</style>
        <p>Just some text</p>
      </div>
    `;
    const nodes = findAddressTextNodes();
    expect(nodes).toHaveLength(0);
  });

  test("skips iframes", () => {
    document.body.innerHTML = `
      <iframe srcdoc="<p>GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG</p>"></iframe>
      <p>Normal text</p>
    `;
    const nodes = findAddressTextNodes();
    expect(nodes).toHaveLength(0);
  });
});

// ── 4. DOM injection — no duplicates ─────────────────────────────────

describe("injectDonateButton", () => {
  test("injects a donate button next to the address", () => {
    document.body.innerHTML = `<p>Send to GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG</p>`;
    const textNode = document.body.querySelector("p")!.firstChild! as Text;
    injectDonateButton(textNode);

    const btn = document.querySelector(".indigopay-donate-btn");
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toContain("Donate via IndigoPay");
  });

  test("does not duplicate buttons on re-scan (PROCESSED_ATTR)", () => {
    document.body.innerHTML = `<p>Send to GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG</p>`;
    const textNode = document.body.querySelector("p")!.firstChild! as Text;

    // First injection
    injectDonateButton(textNode);
    expect(document.querySelectorAll(".indigopay-donate-btn").length).toBe(1);

    // Re-scan should find no new text nodes (parent is marked PROCESSED)
    const nodesAfter = findAddressTextNodes();
    expect(nodesAfter).toHaveLength(0);

    // And still only one button
    expect(document.querySelectorAll(".indigopay-donate-btn").length).toBe(1);
  });

  test("injects donate buttons for multiple addresses in same paragraph", () => {
    document.body.innerHTML = `<p>
      First: GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG
      Second: GBWARNKVFUYBSD6ZBJRLKXFWOZRXB5TIICONCHYQNYFF2J2IRQM4R2KR
    </p>`;
    const textNode = document.body.querySelector("p")!.firstChild! as Text;
    injectDonateButton(textNode);

    const buttons = document.querySelectorAll(".indigopay-donate-btn");
    expect(buttons.length).toBeGreaterThanOrEqual(1);
  });
});

// ── 5. Overlay open/close lifecycle ──────────────────────────────────

describe("Overlay lifecycle", () => {
  beforeEach(() => {
    (mountDonateOverlay as jest.Mock).mockClear();
    (chrome.runtime.sendMessage as jest.Mock).mockClear();

    (chrome.runtime.sendMessage as jest.Mock).mockImplementation(
      (_msg: any, _callback?: Function) => {
        if (_msg.type === "LOOKUP_PROJECT") {
          if (_callback) {
            (_callback as Function)({ project: null });
          }
        }
      },
    );
  });

  test("clicking donate button triggers sendMessage with LOOKUP_PROJECT", () => {
    document.body.innerHTML = `<p>GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG</p>`;
    const textNode = document.body.querySelector("p")!.firstChild! as Text;
    injectDonateButton(textNode);

    const btn = document.querySelector(
      ".indigopay-donate-btn",
    ) as HTMLButtonElement;
    expect(btn).not.toBeNull();

    btn.click();

    expect(chrome.runtime.sendMessage).toHaveBeenCalled();
  });

  test("mountDonateOverlay is called after project lookup", (done) => {
    document.body.innerHTML = `<p>GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG</p>`;
    const textNode = document.body.querySelector("p")!.firstChild! as Text;
    injectDonateButton(textNode);

    const btn = document.querySelector(
      ".indigopay-donate-btn",
    ) as HTMLButtonElement;
    btn.click();

    setTimeout(() => {
      expect(mountDonateOverlay).toHaveBeenCalledWith(
        expect.objectContaining({
          address: expect.stringMatching(/^G[A-Z2-7]{55}$/),
        }),
      );
      done();
    }, 50);
  });
});

// ── 6. SPA navigation resilience ─────────────────────────────────────

describe("SPA navigation resilience", () => {
  test("scanAndInject does not throw on empty body", () => {
    document.body.innerHTML = "";
    expect(() => scanAndInject()).not.toThrow();
  });

  test("scanAndInject processes dynamically added content", () => {
    document.body.innerHTML = `<div id="container"></div>`;

    const container = document.getElementById("container")!;
    const newPara = document.createElement("p");
    newPara.textContent =
      "Donate to GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG";
    container.appendChild(newPara);

    scanAndInject();
    const buttons = document.querySelectorAll(".indigopay-donate-btn");
    expect(buttons.length).toBeGreaterThanOrEqual(1);
  });
});

// ── 7. Address highlighting ──────────────────────────────────────────

describe("Address highlighting", () => {
  test("detected address span has correct highlight styles", () => {
    document.body.innerHTML = `<p>GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG</p>`;
    const textNode = document.body.querySelector("p")!.firstChild! as Text;
    injectDonateButton(textNode);

    const addressSpan = document.querySelector(".indigopay-detected-address");
    expect(addressSpan).not.toBeNull();
    expect(addressSpan!.textContent).toBe(
      "GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG",
    );
    const style = addressSpan!.getAttribute("style") || "";
    expect(style).toContain("rgba(79, 70, 229, 0.08)");
    expect(style).toContain("border-bottom");
  });
});
