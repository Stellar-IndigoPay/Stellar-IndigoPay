/**
 * Tests for extension/src/lib/apiStatusBanner.ts — maps the shared
 * circuit breaker state (apiClient.ts) to the popup's degraded/
 * connecting banner (issue #908).
 *
 * popup.ts itself can't be imported here (it pulls in @stellar/stellar-sdk,
 * an ESM package the Jest/jsdom config isn't set up to transform — see
 * popup.test.ts), so this UI-state mapping lives in its own module and is
 * exercised directly against real DOM elements built in jsdom.
 */

import {
  breakerEventTypeToState,
  describeApiStatus,
  renderApiStatusBanner,
} from "../lib/apiStatusBanner";

describe("describeApiStatus", () => {
  test("returns null when closed (nothing to show)", () => {
    expect(describeApiStatus("closed")).toBeNull();
  });

  test("returns null when state is null/undefined", () => {
    expect(describeApiStatus(null)).toBeNull();
    expect(describeApiStatus(undefined)).toBeNull();
  });

  test("returns a degraded description with retry when open", () => {
    const description = describeApiStatus("open");
    expect(description).not.toBeNull();
    expect(description?.variant).toBe("degraded");
    expect(description?.showRetry).toBe(true);
    expect(description?.text.length).toBeGreaterThan(0);
  });

  test("returns a connecting description without retry when half_open", () => {
    const description = describeApiStatus("half_open");
    expect(description).not.toBeNull();
    expect(description?.variant).toBe("connecting");
    expect(description?.showRetry).toBe(false);
  });
});

describe("breakerEventTypeToState", () => {
  test("maps breaker_open -> open", () => {
    expect(breakerEventTypeToState("breaker_open")).toBe("open");
  });

  test("maps breaker_half_open -> half_open", () => {
    expect(breakerEventTypeToState("breaker_half_open")).toBe("half_open");
  });

  test("maps breaker_closed and anything else -> closed", () => {
    expect(breakerEventTypeToState("breaker_closed")).toBe("closed");
    expect(breakerEventTypeToState(undefined)).toBe("closed");
    expect(breakerEventTypeToState("something_else")).toBe("closed");
  });
});

describe("renderApiStatusBanner (DOM)", () => {
  function buildElements() {
    const banner = document.createElement("div");
    const text = document.createElement("span");
    const retryButton = document.createElement("button");
    retryButton.classList.add("hidden");
    banner.appendChild(text);
    banner.appendChild(retryButton);
    return { banner, text, retryButton };
  }

  test("hides the banner when state is closed", () => {
    const elements = buildElements();
    elements.banner.className = "api-status-banner degraded"; // simulate prior visible state
    renderApiStatusBanner(elements, "closed");
    expect(elements.banner.className).toBe("api-status-banner hidden");
  });

  test("shows the degraded banner with a visible retry button when open", () => {
    const elements = buildElements();
    renderApiStatusBanner(elements, "open");
    expect(elements.banner.className).toBe("api-status-banner degraded");
    expect(elements.text.textContent).toMatch(/degraded/i);
    expect(elements.retryButton.classList.contains("hidden")).toBe(false);
  });

  test("shows the connecting banner with the retry button hidden when half_open", () => {
    const elements = buildElements();
    renderApiStatusBanner(elements, "half_open");
    expect(elements.banner.className).toBe("api-status-banner connecting");
    expect(elements.text.textContent).toMatch(/reconnecting/i);
    expect(elements.retryButton.classList.contains("hidden")).toBe(true);
  });

  test("works without a retry button present", () => {
    const banner = document.createElement("div");
    const text = document.createElement("span");
    expect(() => renderApiStatusBanner({ banner, text }, "open")).not.toThrow();
    expect(banner.className).toBe("api-status-banner degraded");
  });

  test("null/undefined state hides the banner", () => {
    const elements = buildElements();
    renderApiStatusBanner(elements, null);
    expect(elements.banner.className).toBe("api-status-banner hidden");
    renderApiStatusBanner(elements, undefined);
    expect(elements.banner.className).toBe("api-status-banner hidden");
  });
});
