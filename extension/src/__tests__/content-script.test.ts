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
 * - buildBodyContent, escapeHtml, truncateAddress, getCategoryEmoji
 * - freighterSectionHTML, updateSubmitBtn, wireBodyEvents
 * - createDonateButton, injectDonateButton edge cases
 * - findAddressTextNodes edge cases
 * - isInsideProcessedElement edge cases
 */

// Chrome API is mocked via jest.setup.js (setupFiles)

import {
  STELLAR_ADDRESS_RE,
  findAddressTextNodes,
  extractAddresses,
  injectDonateButton,
  scanAndInject,
  isInsideProcessedElement,
  createDonateButton,
  escapeHtml,
  truncateAddress,
  truncateStr,
  getCategoryEmoji,
  freighterSectionHTML,
  updateSubmitBtn,
  buildBodyContent,
  handleDonateClick,
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

  test("extracts multiple unique addresses", () => {
    const textNode = document.createTextNode(
      "Addr1: GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG and Addr2: GBWARNKVFUYBSD6ZBJRLKXFWOZRXB5TIICONCHYQNYFF2J2IRQM4R2KR",
    );
    const result = extractAddresses(textNode);
    expect(result).toHaveLength(2);
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

  test("skips noscript elements", () => {
    document.body.innerHTML = `
      <noscript><p>GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG</p></noscript>
      <p>Normal text</p>
    `;
    const nodes = findAddressTextNodes();
    expect(nodes).toHaveLength(0);
  });

  test("returns empty array when body is empty", () => {
    document.body.innerHTML = "";
    const nodes = findAddressTextNodes();
    expect(nodes).toHaveLength(0);
  });
});

// ── 4. isInsideProcessedElement ──────────────────────────────────────

describe("isInsideProcessedElement", () => {
  test("returns false for node outside processed element", () => {
    document.body.innerHTML = `<div><p>GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG</p></div>`;
    const textNode = document.body.querySelector("p")!.firstChild!;
    expect(isInsideProcessedElement(textNode)).toBe(false);
  });

  test("returns true for node inside processed element", () => {
    document.body.innerHTML = `<div data-indigopay-processed="true"><p>GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG</p></div>`;
    const textNode = document.body.querySelector("p")!.firstChild!;
    expect(isInsideProcessedElement(textNode)).toBe(true);
  });

  test("returns true when ancestor is processed", () => {
    document.body.innerHTML = `<div data-indigopay-processed="true"><section><p>GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG</p></section></div>`;
    const textNode = document.body.querySelector("p")!.firstChild!;
    expect(isInsideProcessedElement(textNode)).toBe(true);
  });

  test("returns false for orphaned text node", () => {
    const textNode = document.createTextNode("test");
    expect(isInsideProcessedElement(textNode)).toBe(false);
  });
});

// ── 4b. DOM injection — no duplicates ────────────────────────────────

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

  test("marks parent with PROCESSED_ATTR", () => {
    document.body.innerHTML = `<p>GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG</p>`;
    const parent = document.body.querySelector("p")!;
    const textNode = parent.firstChild! as Text;
    injectDonateButton(textNode);

    expect(parent.hasAttribute("data-indigopay-processed")).toBe(true);
  });

  test("handles text without addresses gracefully", () => {
    document.body.innerHTML = `<p>No addresses here</p>`;
    const textNode = document.body.querySelector("p")!.firstChild! as Text;
    expect(() => injectDonateButton(textNode)).not.toThrow();
  });

  test("does nothing with null parent", () => {
    const textNode = document.createTextNode("GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG");
    expect(() => injectDonateButton(textNode)).not.toThrow();
  });
});

// ── 5. createDonateButton ────────────────────────────────────────────

describe("createDonateButton", () => {
  test("creates a button with correct text", () => {
    const addr = "GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG";
    const btn = createDonateButton(addr);

    expect(btn.tagName).toBe("BUTTON");
    expect(btn.textContent).toContain("Donate via IndigoPay");
    expect(btn.className).toBe("indigopay-donate-btn");
    expect(btn.dataset.address).toBe(addr);
    expect(btn.getAttribute("data-indigopay-address")).toBe(addr);
  });

  test("button has inline styles", () => {
    const btn = createDonateButton("GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG");
    const style = btn.getAttribute("style") || "";
    expect(style).toContain("display");
    expect(style).toContain("background");
  });

  test("clicking button triggers chrome.runtime.sendMessage", () => {
    document.body.innerHTML = `<p>GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG</p>`;
    const textNode = document.body.querySelector("p")!.firstChild! as Text;
    injectDonateButton(textNode);

    const btn = document.querySelector(".indigopay-donate-btn") as HTMLButtonElement;
    btn.click();

    expect(chrome.runtime.sendMessage).toHaveBeenCalled();
  });
});

// ── 6. Overlay lifecycle ─────────────────────────────────────────────

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

  test("does not overwrite overlay if older request completes after newer request", () => {
    // Simulate B-then-A callback ordering
    let cbA: Function | undefined;
    let cbB: Function | undefined;

    (chrome.runtime.sendMessage as jest.Mock).mockImplementation(
      (_msg: any, callback?: Function) => {
        if (_msg.address === "GA_ADDRESS") cbA = callback;
        if (_msg.address === "GB_ADDRESS") cbB = callback;
      }
    );

    document.body.innerHTML = `
      <div id="indigopay-overlay"><div class="igp-body"></div></div>
    `;

    // Fire request A
    handleDonateClick("GA_ADDRESS");
    // Fire request B immediately after
    handleDonateClick("GB_ADDRESS");

    // Resolve B first
    if (cbB) {
      cbB({ project: { name: "Project B", category: "test" } });
    }
    
    // Resolve A later
    if (cbA) {
      cbA({ project: { name: "Project A", category: "test" } });
    }

    // The body should have Project B's content (not Project A)
    const bodyEl = document.querySelector(".igp-body");
    expect(bodyEl?.innerHTML).not.toContain("Project A");
  });
});

// ── 7. SPA navigation resilience ────────────────────────────────────

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

// ── 8. Address highlighting ──────────────────────────────────────────

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

// ── 9. escapeHtml ────────────────────────────────────────────────────

describe("escapeHtml", () => {
  test("escapes all HTML special chars", () => {
    expect(escapeHtml("<script>alert('xss')</script>")).toBe(
      "&lt;script&gt;alert(&#039;xss&#039;)&lt;/script&gt;",
    );
  });

  test("returns plain text unchanged", () => {
    expect(escapeHtml("Hello World")).toBe("Hello World");
  });

  test("handles empty string", () => {
    expect(escapeHtml("")).toBe("");
  });

  test("escapes ampersand", () => {
    expect(escapeHtml("A & B")).toBe("A &amp; B");
  });

  test("escapes double quote", () => {
    expect(escapeHtml('He said "hello"')).toBe("He said &quot;hello&quot;");
  });
});

// ── 10. truncateAddress ──────────────────────────────────────────────

describe("truncateAddress", () => {
  test("truncates long address", () => {
    const addr = "GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG";
    expect(truncateAddress(addr)).toBe("GDFJEG…KKHG");
  });

  test("returns short string as-is", () => {
    expect(truncateAddress("short")).toBe("short");
  });

  test("returns string at boundary as-is", () => {
    expect(truncateAddress("123456789012")).toBe("123456789012");
  });
});

// ── 11. truncateStr ──────────────────────────────────────────────────

describe("truncateStr", () => {
  test("truncates long text", () => {
    expect(truncateStr("Hello World", 5)).toBe("Hello…");
  });

  test("returns short text unchanged", () => {
    expect(truncateStr("Hi", 10)).toBe("Hi");
  });

  test("handles exact length", () => {
    expect(truncateStr("Hello", 5)).toBe("Hello");
  });
});

// ── 12. getCategoryEmoji ─────────────────────────────────────────────

describe("getCategoryEmoji", () => {
  test("returns correct emoji for known categories", () => {
    expect(getCategoryEmoji("Reforestation")).toBe("🌳");
    expect(getCategoryEmoji("Solar Energy")).toBe("☀️");
    expect(getCategoryEmoji("Ocean Conservation")).toBe("🌊");
    expect(getCategoryEmoji("Clean Water")).toBe("💧");
    expect(getCategoryEmoji("Wildlife Protection")).toBe("🦁");
    expect(getCategoryEmoji("Carbon Capture")).toBe("♻️");
    expect(getCategoryEmoji("Wind Energy")).toBe("💨");
    expect(getCategoryEmoji("Sustainable Agriculture")).toBe("🌾");
  });

  test("returns default emoji for unknown category", () => {
    expect(getCategoryEmoji("Random")).toBe("🌿");
    expect(getCategoryEmoji("")).toBe("🌿");
  });
});

// ── 13. freighterSectionHTML ─────────────────────────────────────────

describe("freighterSectionHTML", () => {
  test("returns connected state when publicKey is provided", () => {
    const html = freighterSectionHTML(true, "GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG");
    expect(html).toContain("igp-freighter-connected");
    expect(html).toContain("GDFJEG…KKHG");
    expect(html).not.toContain("igp-connect-freighter");
  });

  test("returns connect button when freighter is available but not connected", () => {
    const html = freighterSectionHTML(true, "");
    expect(html).toContain("igp-connect-freighter");
    expect(html).toContain("Connect Freighter Wallet");
    expect(html).not.toContain("igp-freighter-connected");
  });

  test("returns missing message when freighter is not available", () => {
    const html = freighterSectionHTML(false, "");
    expect(html).toContain("igp-freighter-missing");
    expect(html).toContain("Freighter wallet");
    expect(html).toContain("freighter.app");
  });
});

// ── 14. updateSubmitBtn ──────────────────────────────────────────────

describe("updateSubmitBtn", () => {
  test("disables button when no public key", () => {
    const btn = document.createElement("button");
    updateSubmitBtn(null, btn, "");
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toBe("💚 Connect Wallet to Donate");
  });

  test("enables button when amount and public key are set", () => {
    const input = document.createElement("input");
    input.value = "5";
    const btn = document.createElement("button");
    updateSubmitBtn(input, btn, "GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG");
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe("💚 Confirm Donation");
  });

  test("shows enter amount message when no amount", () => {
    const input = document.createElement("input");
    input.value = "";
    const btn = document.createElement("button");
    updateSubmitBtn(input, btn, "GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG");
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toBe("Enter an amount");
  });

  test("handles null inputs gracefully", () => {
    const btn = document.createElement("button");
    updateSubmitBtn(null, btn, "GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG");
    expect(btn.disabled).toBe(true);
  });

  test("handles null button gracefully", () => {
    expect(() => updateSubmitBtn(null, null, "")).not.toThrow();
  });
});

// ── 15. buildBodyContent ─────────────────────────────────────────────

describe("buildBodyContent", () => {
  test("returns direct donate view when no project", () => {
    const result = buildBodyContent(
      "GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG",
      null,
      false,
      "",
      ["10", "50", "100", "500"],
    );
    expect(result.renderDirectDonateViewStr).toContain("igp-direct-section");
    expect(result.renderDirectDonateViewStr).toContain("doesn't match a registered");
    expect(result.renderProjectViewStr).toBe("");
  });

  test("returns project view when project is provided", () => {
    const result = buildBodyContent(
      "GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG",
      {
        id: "proj-1",
        name: "Amazon Reforestation",
        category: "Reforestation",
        verified: true,
        walletAddress: "GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG",
        location: "Brazil",
      },
      false,
      "",
      ["10", "50", "100", "500"],
    );
    expect(result.renderProjectViewStr).toContain("Amazon Reforestation");
    expect(result.renderProjectViewStr).toContain("Brazil");
    expect(result.renderProjectViewStr).not.toContain("doesn't match a registered");
    expect(result.renderDirectDonateViewStr).toContain("igp-direct-section");
  });

  test("includes freighter section in both views", () => {
    const result = buildBodyContent(
      "GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG",
      null,
      true,
      "GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG",
      ["10", "50", "100", "500"],
    );
    expect(result.renderDirectDonateViewStr).toContain("igp-freighter-connected");
  });
});
