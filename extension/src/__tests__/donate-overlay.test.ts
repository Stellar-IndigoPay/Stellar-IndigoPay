/**
 * Tests for the inline donate overlay (donate-overlay.ts)
 *
 * Covers:
 * - Overlay mounts with correct project info
 * - Overlay mounts with direct donate view (no project)
 * - Loading state
 * - Close button, backdrop, ESC key
 * - Preset amount buttons + active class
 * - Copy address button (clipboard and fallback)
 * - Freighter connect/disconnect
 * - Submit donation (pending acknowledgement, error, minimum validation)
 * - Custom amount input
 * - Project with description renders
 * - Unverified project badge
 */

import { mountDonateOverlay, type DonateOverlayOptions } from "../inject/donate-overlay";

// Helper to create default options
function createOptions(
  overrides: Partial<DonateOverlayOptions> = {},
): DonateOverlayOptions {
  return {
    address: "GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG",
    project: null,
    onClose: jest.fn(),
    onDonate: jest.fn().mockResolvedValue(undefined),
    freighterAvailable: false,
    freighterPublicKey: "",
    onConnectFreighter: jest.fn().mockResolvedValue(""),
    ...overrides,
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
  jest.clearAllMocks();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
  const overlay = document.getElementById("indigopay-overlay");
  if (overlay) overlay.remove();
});

// ── 1. Mount overlay (project info) ──────────────────────────────────

describe("mountDonateOverlay", () => {
  test("mounts overlay with project info when project is provided", () => {
    const opts = createOptions({
      project: {
        id: "proj-123",
        name: "Amazon Reforestation",
        category: "Reforestation",
        verified: true,
        walletAddress:
          "GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG",
        location: "Brazil",
      },
    });

    const cleanup = mountDonateOverlay(opts);
    const overlay = document.getElementById("indigopay-overlay");

    expect(overlay).not.toBeNull();
    expect(overlay!.querySelector(".igp-project-name")!.textContent).toContain(
      "Amazon Reforestation",
    );
    expect(overlay!.querySelector(".igp-badge-verified")).not.toBeNull();
    expect(overlay!.textContent).toContain("Reforestation");
    expect(overlay!.textContent).toContain("Brazil");

    cleanup();
  });

  test("mounts overlay with unverified badge when project is not verified", () => {
    const opts = createOptions({
      project: {
        id: "proj-456",
        name: "Unverified Project",
        category: "Solar Energy",
        verified: false,
        walletAddress:
          "GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG",
      },
    });

    const cleanup = mountDonateOverlay(opts);
    const overlay = document.getElementById("indigopay-overlay");

    expect(overlay!.querySelector(".igp-badge-unverified")).not.toBeNull();
    expect(overlay!.querySelector(".igp-badge-verified")).toBeNull();

    cleanup();
  });

  test("mounts project view with description", () => {
    const opts = createOptions({
      project: {
        id: "proj-789",
        name: "Project With Description",
        category: "Clean Water",
        verified: true,
        walletAddress: "GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG",
        description: "This project provides clean water to communities in need across rural areas.",
      },
    });

    const cleanup = mountDonateOverlay(opts);
    const overlay = document.getElementById("indigopay-overlay");
    expect(overlay!.querySelector(".igp-project-desc")).not.toBeNull();

    cleanup();
  });

  test("mounts project without location", () => {
    const opts = createOptions({
      project: {
        id: "proj-no-loc",
        name: "No Location Project",
        category: "Wind Energy",
        verified: false,
        walletAddress: "GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG",
      },
    });

    const cleanup = mountDonateOverlay(opts);
    const overlay = document.getElementById("indigopay-overlay");
    expect(overlay!.querySelector(".igp-project-location")).toBeNull();

    cleanup();
  });

  // ── 2. Direct donate view (no project) ──────────────────────────

  test("mounts direct donate view when no project matches", () => {
    const opts = createOptions();

    const cleanup = mountDonateOverlay(opts);
    const overlay = document.getElementById("indigopay-overlay");

    expect(overlay).not.toBeNull();
    expect(overlay!.textContent).toContain("doesn't match a registered");
    expect(overlay!.querySelector(".igp-direct-section")).not.toBeNull();
    expect(overlay!.querySelector(".igp-copy-btn")).not.toBeNull();

    cleanup();
  });

  test("removes existing overlay before mounting a new one", () => {
    const opts1 = createOptions();
    const opts2 = createOptions();

    const cleanup1 = mountDonateOverlay(opts1);
    const overlay1 = document.getElementById("indigopay-overlay");
    expect(overlay1).not.toBeNull();

    const cleanup2 = mountDonateOverlay(opts2);
    expect(document.querySelectorAll("#indigopay-overlay").length).toBe(1);

    cleanup1();
    cleanup2();
  });

  // ── 3. Loading state ────────────────────────────────────────────

  test("shows loading spinner when isLoading is true", () => {
    const opts = createOptions({ isLoading: true });

    const cleanup = mountDonateOverlay(opts);
    const overlay = document.getElementById("indigopay-overlay");

    expect(overlay!.querySelector(".igp-loading")).not.toBeNull();
    expect(overlay!.querySelector(".igp-spinner")).not.toBeNull();
    expect(overlay!.textContent).toContain("Loading project info");

    cleanup();
  });

  // ── 4. Close button ─────────────────────────────────────────────

  test("close button triggers onClose callback", () => {
    const onClose = jest.fn();
    const opts = createOptions({ onClose });

    const cleanup = mountDonateOverlay(opts);
    const closeBtn = document.querySelector(
      ".igp-close-btn",
    ) as HTMLButtonElement;
    expect(closeBtn).not.toBeNull();

    closeBtn.click();
    expect(onClose).toHaveBeenCalled();

    cleanup();
  });

  test("overlay is removed from DOM after close", () => {
    const onClose = jest.fn();
    const opts = createOptions({ onClose });

    const cleanup = mountDonateOverlay(opts);
    expect(document.getElementById("indigopay-overlay")).not.toBeNull();

    cleanup();
    expect(document.getElementById("indigopay-overlay")).toBeNull();
  });

  // ── 5. Backdrop click closes ────────────────────────────────────

  test("backdrop click closes the overlay", () => {
    const onClose = jest.fn();
    const opts = createOptions({ onClose });

    const cleanup = mountDonateOverlay(opts);
    const backdrop = document.querySelector(".igp-backdrop") as HTMLElement;
    expect(backdrop).not.toBeNull();

    backdrop.click();
    expect(onClose).toHaveBeenCalled();

    cleanup();
  });

  // ── 6. ESC key closes ───────────────────────────────────────────

  test("ESC key closes the overlay", () => {
    const onClose = jest.fn();
    const opts = createOptions({ onClose });

    const cleanup = mountDonateOverlay(opts);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onClose).toHaveBeenCalled();

    cleanup();
  });

  test("other keys do not close the overlay", () => {
    const onClose = jest.fn();
    const opts = createOptions({ onClose });

    const cleanup = mountDonateOverlay(opts);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(onClose).not.toHaveBeenCalled();

    cleanup();
  });

  // ── 7. Preset amount buttons ────────────────────────────────────

  test("preset amount buttons set the amount input value", () => {
    const opts = createOptions({
      project: {
        id: "proj-1",
        name: "Test Project",
        category: "Reforestation",
        verified: true,
        walletAddress:
          "GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG",
      },
    });

    const cleanup = mountDonateOverlay(opts);

    const presetBtns = document.querySelectorAll(".igp-preset-btn");
    expect(presetBtns.length).toBeGreaterThanOrEqual(4);

    const fiveBtn = Array.from(presetBtns).find(
      (b) => b.getAttribute("data-amount") === "50",
    ) as HTMLButtonElement;
    expect(fiveBtn).not.toBeNull();
    fiveBtn.click();

    const amountInput = document.getElementById(
      "igp-amount-input",
    ) as HTMLInputElement;
    expect(amountInput.value).toBe("50");

    cleanup();
  });

  test("preset button gets active class when clicked", () => {
    const opts = createOptions({
      project: {
        id: "proj-1",
        name: "Test Project",
        category: "Reforestation",
        verified: true,
        walletAddress:
          "GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG",
      },
    });

    const cleanup = mountDonateOverlay(opts);

    const presetBtns = document.querySelectorAll(".igp-preset-btn");
    const tenBtn = Array.from(presetBtns).find(
      (b) => b.getAttribute("data-amount") === "10",
    ) as HTMLButtonElement;
    tenBtn.click();

    expect(tenBtn.classList.contains("active")).toBe(true);

    cleanup();
  });

  // ── 8. Copy address button ──────────────────────────────────────

  test("copy button copies address to clipboard", async () => {
    const writeTextMock = jest.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: {
        writeText: writeTextMock,
      },
    });

    const opts = createOptions();
    const cleanup = mountDonateOverlay(opts);

    const copyBtn = document.querySelector(".igp-copy-btn") as HTMLButtonElement;
    expect(copyBtn).not.toBeNull();

    copyBtn.click();
    expect(writeTextMock).toHaveBeenCalledWith(
      "GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG",
    );

    cleanup();
  });

  test("copy button falls back when clipboard API fails", async () => {
    const writeTextMock = jest.fn().mockRejectedValue(new Error("denied"));
    Object.assign(navigator, {
      clipboard: {
        writeText: writeTextMock,
      },
    });

    document.execCommand = jest.fn().mockReturnValue(true);

    const opts = createOptions();
    const cleanup = mountDonateOverlay(opts);

    const copyBtn = document.querySelector(".igp-copy-btn") as HTMLButtonElement;
    expect(copyBtn).not.toBeNull();

    copyBtn.click();

    // Wait for async fallback to complete
    await Promise.resolve();

    // Should have tried clipboard API
    expect(writeTextMock).toHaveBeenCalled();
    // And fell back to execCommand
    expect(document.execCommand).toHaveBeenCalledWith("copy");

    cleanup();
  });

  // ── 9. Freighter section ────────────────────────────────────────

  test("shows Freighter connect button when Freighter is available", () => {
    const opts = createOptions({
      freighterAvailable: true,
      freighterPublicKey: "",
    });

    const cleanup = mountDonateOverlay(opts);
    const overlay = document.getElementById("indigopay-overlay");

    expect(overlay!.querySelector("#igp-connect-freighter")).not.toBeNull();
    expect(
      overlay!.querySelector(".igp-freighter-connected"),
    ).toBeNull();

    cleanup();
  });

  test("shows connected state when Freighter public key is provided", () => {
    const opts = createOptions({
      freighterAvailable: true,
      freighterPublicKey:
        "GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG",
    });

    const cleanup = mountDonateOverlay(opts);
    const overlay = document.getElementById("indigopay-overlay");

    expect(overlay!.querySelector(".igp-freighter-connected")).not.toBeNull();
    expect(overlay!.querySelector("#igp-connect-freighter")).toBeNull();

    cleanup();
  });

  test("shows Freighter missing message when Freighter is not available", () => {
    const opts = createOptions({
      freighterAvailable: false,
    });

    const cleanup = mountDonateOverlay(opts);
    const overlay = document.getElementById("indigopay-overlay");

    expect(overlay!.querySelector(".igp-freighter-missing")).not.toBeNull();

    cleanup();
  });

  test("Freighter connected state with project view", () => {
    const opts = createOptions({
      project: {
        id: "proj-1",
        name: "Test Project",
        category: "Reforestation",
        verified: true,
        walletAddress: "GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG",
      },
      freighterAvailable: true,
      freighterPublicKey: "GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG",
    });

    const cleanup = mountDonateOverlay(opts);
    const overlay = document.getElementById("indigopay-overlay");
    expect(overlay!.querySelector(".igp-freighter-connected")).not.toBeNull();

    cleanup();
  });

  // ── 10. Connect Freighter button ────────────────────────────────

  test("connect Freighter button triggers onConnectFreighter", async () => {
    const onConnectFreighter = jest.fn().mockResolvedValue(
      "GCONNECTEDKEYGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    );
    const opts = createOptions({
      freighterAvailable: true,
      freighterPublicKey: "",
      onConnectFreighter,
    });

    const cleanup = mountDonateOverlay(opts);
    const connectBtn = document.querySelector("#igp-connect-freighter") as HTMLButtonElement;
    expect(connectBtn).not.toBeNull();

    connectBtn.click();

    await jest.runAllTimersAsync();

    expect(onConnectFreighter).toHaveBeenCalled();
    expect(connectBtn.textContent).toContain("Connecting");

    cleanup();
  });

  test("connect Freighter shows error on failure", async () => {
    const onConnectFreighter = jest.fn().mockRejectedValue(new Error("User rejected"));
    const opts = createOptions({
      freighterAvailable: true,
      freighterPublicKey: "",
      onConnectFreighter,
    });

    const cleanup = mountDonateOverlay(opts);
    const connectBtn = document.querySelector("#igp-connect-freighter") as HTMLButtonElement;
    connectBtn.click();

    await jest.runAllTimersAsync();

    const statusEl = document.querySelector("#igp-donate-status");
    expect(statusEl!.textContent).toContain("Failed to connect");
    expect(statusEl!.className).toContain("igp-status-error");

    cleanup();
  });

  // ── 11. Submit button state ─────────────────────────────────────

  test("submit button is disabled when no amount is entered", () => {
    const opts = createOptions({
      project: {
        id: "proj-1",
        name: "Test",
        category: "Reforestation",
        verified: true,
        walletAddress:
          "GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG",
      },
      freighterPublicKey:
        "GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG",
    });

    const cleanup = mountDonateOverlay(opts);
    const submitBtn = document.getElementById(
      "igp-submit-btn",
    ) as HTMLButtonElement;

    expect(submitBtn.disabled).toBe(true);

    cleanup();
  });

  test("submit button is disabled when no wallet is connected", () => {
    const opts = createOptions({
      project: {
        id: "proj-1",
        name: "Test",
        category: "Reforestation",
        verified: true,
        walletAddress:
          "GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG",
      },
      freighterPublicKey: "",
    });

    const cleanup = mountDonateOverlay(opts);
    const submitBtn = document.getElementById(
      "igp-submit-btn",
    ) as HTMLButtonElement;

    expect(submitBtn.disabled).toBe(true);

    cleanup();
  });

  // ── 12. Donation submission ─────────────────────────────────────

  test("onDonate is called with amount and memo when submitted", async () => {
    const onDonate = jest.fn().mockResolvedValue(undefined);
    const opts = createOptions({
      project: {
        id: "proj-1",
        name: "Test",
        category: "Reforestation",
        verified: true,
        walletAddress:
          "GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG",
      },
      onDonate,
      freighterPublicKey:
        "GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG",
    });

    const cleanup = mountDonateOverlay(opts);

    const amountInput = document.getElementById(
      "igp-amount-input",
    ) as HTMLInputElement;
    amountInput.value = "10";

    const memoInput = document.getElementById(
      "igp-memo-input",
    ) as HTMLInputElement;
    memoInput.value = "Great work!";

    amountInput.dispatchEvent(new Event("input"));

    const submitBtn = document.getElementById(
      "igp-submit-btn",
    ) as HTMLButtonElement;
    submitBtn.click();

    await jest.runAllTimersAsync();

    expect(onDonate).toHaveBeenCalledWith("10", "Great work!");

    cleanup();
  });

  test("shows minimum donation error when amount is too low", async () => {
    const onDonate = jest.fn().mockResolvedValue(undefined);
    const opts = createOptions({
      project: {
        id: "proj-1",
        name: "Test",
        category: "Reforestation",
        verified: true,
        walletAddress:
          "GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG",
      },
      onDonate,
      freighterPublicKey:
        "GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG",
    });

    const cleanup = mountDonateOverlay(opts);

    // Set a valid amount first to enable the button
    const amountInput = document.getElementById(
      "igp-amount-input",
    ) as HTMLInputElement;
    amountInput.value = "5";
    amountInput.dispatchEvent(new Event("input"));

    // Verify button is enabled
    const submitBtn = document.getElementById(
      "igp-submit-btn",
    ) as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(false);

    // Now set amount too low
    amountInput.value = "0.05";

    submitBtn.click();

    const statusEl = document.getElementById("igp-donate-status");
    expect(statusEl!.textContent).toContain("Minimum donation");
    expect(statusEl!.className).toContain("igp-status-error");
    expect(onDonate).not.toHaveBeenCalled();

    cleanup();
  });

  test("shows error message when donation fails", async () => {
    const onDonate = jest.fn().mockRejectedValue(new Error("Insufficient funds"));
    const opts = createOptions({
      project: {
        id: "proj-1",
        name: "Test",
        category: "Reforestation",
        verified: true,
        walletAddress:
          "GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG",
      },
      onDonate,
      freighterPublicKey:
        "GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG",
    });

    const cleanup = mountDonateOverlay(opts);

    const amountInput = document.getElementById(
      "igp-amount-input",
    ) as HTMLInputElement;
    amountInput.value = "50";
    amountInput.dispatchEvent(new Event("input"));

    const submitBtn = document.getElementById(
      "igp-submit-btn",
    ) as HTMLButtonElement;
    submitBtn.click();

    await jest.runAllTimersAsync();

    const statusEl = document.getElementById("igp-donate-status");
    expect(statusEl!.textContent).toContain("Insufficient funds");
    expect(statusEl!.className).toContain("igp-status-error");
    expect(submitBtn.textContent).toBe("💚 Try Again");

    cleanup();
  });

  test("shows generic error when donation throws without message", async () => {
    const onDonate = jest.fn().mockRejectedValue("unknown error");
    const opts = createOptions({
      project: {
        id: "proj-1",
        name: "Test",
        category: "Reforestation",
        verified: true,
        walletAddress:
          "GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG",
      },
      onDonate,
      freighterPublicKey:
        "GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG",
    });

    const cleanup = mountDonateOverlay(opts);

    const amountInput = document.getElementById(
      "igp-amount-input",
    ) as HTMLInputElement;
    amountInput.value = "10";
    amountInput.dispatchEvent(new Event("input"));

    const submitBtn = document.getElementById(
      "igp-submit-btn",
    ) as HTMLButtonElement;
    submitBtn.click();

    await jest.runAllTimersAsync();

    const statusEl = document.getElementById("igp-donate-status");
    expect(statusEl!.textContent).toContain("Transaction failed");

    cleanup();
  });

  test("shows pending request message after acknowledgement", async () => {
    const onDonate = jest.fn().mockResolvedValue(undefined);
    const opts = createOptions({
      project: {
        id: "proj-1",
        name: "Test",
        category: "Reforestation",
        verified: true,
        walletAddress:
          "GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG",
      },
      onDonate,
      freighterPublicKey:
        "GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG",
    });

    const cleanup = mountDonateOverlay(opts);

    const amountInput = document.getElementById(
      "igp-amount-input",
    ) as HTMLInputElement;
    amountInput.value = "25";
    amountInput.dispatchEvent(new Event("input"));

    const submitBtn = document.getElementById(
      "igp-submit-btn",
    ) as HTMLButtonElement;
    submitBtn.click();

    await jest.runAllTimersAsync();

    const statusEl = document.getElementById("igp-donate-status");
    expect(statusEl!.textContent).toContain(
      "Donation request submitted; awaiting transaction confirmation",
    );
    expect(statusEl!.className).toContain("igp-status-pending");
    expect(submitBtn.textContent).toBe("✅ Request sent");

    cleanup();
  });

  // ── 13. Custom amount input ─────────────────────────────────────

  test("custom amount input triggers preset deselection and button update", () => {
    const opts = createOptions({
      project: {
        id: "proj-1",
        name: "Test",
        category: "Reforestation",
        verified: true,
        walletAddress:
          "GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG",
      },
      freighterPublicKey:
        "GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG",
    });

    const cleanup = mountDonateOverlay(opts);

    // First click a preset to make it active
    const presetBtns = document.querySelectorAll(".igp-preset-btn");
    const fiveBtn = Array.from(presetBtns).find(
      (b) => b.getAttribute("data-amount") === "50",
    ) as HTMLButtonElement;
    fiveBtn.click();
    expect(fiveBtn.classList.contains("active")).toBe(true);

    // Then type a custom amount
    const amountInput = document.getElementById(
      "igp-amount-input",
    ) as HTMLInputElement;
    amountInput.value = "42";
    amountInput.dispatchEvent(new Event("input"));

    // Preset should lose active class
    expect(fiveBtn.classList.contains("active")).toBe(false);

    cleanup();
  });

  // ── 14. Direct donate view edge cases ───────────────────────────

  test("direct donate with freighter connected shows 'Send Donation' button", () => {
    const opts = createOptions({
      freighterAvailable: true,
      freighterPublicKey: "GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG",
    });

    const cleanup = mountDonateOverlay(opts);
    const submitBtn = document.getElementById("igp-submit-btn") as HTMLButtonElement;
    expect(submitBtn).not.toBeNull();
    expect(submitBtn.textContent).toContain("Send Donation");

    cleanup();
  });

  test("direct donate with freighter not available shows missing message", () => {
    const opts = createOptions({
      freighterAvailable: false,
      freighterPublicKey: "",
    });

    const cleanup = mountDonateOverlay(opts);
    const overlay = document.getElementById("indigopay-overlay");
    expect(overlay!.querySelector(".igp-freighter-missing")).not.toBeNull();

    cleanup();
  });
});
