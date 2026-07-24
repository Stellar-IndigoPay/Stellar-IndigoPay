/**
 * Tests for the inline donate overlay (donate-overlay.ts)
 *
 * Covers:
 * - Overlay mounts with correct project info
 * - Overlay mounts with direct donate view (no project)
 * - Close button works
 * - Backdrop click closes
 * - ESC key closes
 * - Preset amount buttons work
 * - Copy address button works
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
  // Clean up any overlays
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
    // The first overlay should now be removed
    expect(document.querySelectorAll("#indigopay-overlay").length).toBe(1);

    cleanup1();
    cleanup2();
  });

  // ── 3. Close button ─────────────────────────────────────────────

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

  // ── 4. Backdrop click closes ────────────────────────────────────

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

  // ── 5. ESC key closes ───────────────────────────────────────────

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

  // ── 6. Preset amount buttons ────────────────────────────────────

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

    // Click the "5" preset
    const fiveBtn = Array.from(presetBtns).find(
      (b) => b.getAttribute("data-amount") === "5",
    ) as HTMLButtonElement;
    expect(fiveBtn).not.toBeNull();
    fiveBtn.click();

    const amountInput = document.getElementById(
      "igp-amount-input",
    ) as HTMLInputElement;
    expect(amountInput.value).toBe("5");

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

  // ── 7. Copy address button ──────────────────────────────────────

  test("copy button copies address to clipboard", async () => {
    // Mock clipboard API
    const writeTextMock = jest.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: {
        writeText: writeTextMock,
      },
    });

    const opts = createOptions(); // Direct donate view has the copy button
    const cleanup = mountDonateOverlay(opts);

    const copyBtn = document.querySelector(".igp-copy-btn") as HTMLButtonElement;
    expect(copyBtn).not.toBeNull();

    copyBtn.click();
    expect(writeTextMock).toHaveBeenCalledWith(
      "GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG",
    );

    cleanup();
  });

  // ── 8. Freighter section ────────────────────────────────────────

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

  // ── 9. Submit button state ──────────────────────────────────────

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

    // Without amount, button should be disabled
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

  // ── 10. Donation submission ─────────────────────────────────────

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

    // Set amount
    const amountInput = document.getElementById(
      "igp-amount-input",
    ) as HTMLInputElement;
    amountInput.value = "10";

    // Set memo
    const memoInput = document.getElementById(
      "igp-memo-input",
    ) as HTMLInputElement;
    memoInput.value = "Great work!";

    // Trigger input event to enable submit
    amountInput.dispatchEvent(new Event("input"));

    // Click submit
    const submitBtn = document.getElementById(
      "igp-submit-btn",
    ) as HTMLButtonElement;
    submitBtn.click();

    // Wait for async
    await jest.runAllTimersAsync();

    expect(onDonate).toHaveBeenCalledWith("10", "Great work!");

    cleanup();
  });
});
