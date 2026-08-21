/**
 * extension/src/lib/apiStatusBanner.ts
 *
 * Framework-agnostic mapping from circuit breaker state (apiClient.ts) to
 * the popup's degraded/connecting banner. Kept separate from apiClient.ts
 * (transport) and from popup.ts (which pulls in @stellar/stellar-sdk and
 * therefore can't be imported directly from the Jest/jsdom test suite —
 * see extension/src/__tests__/popup.test.ts) so the UI-state logic here
 * stays independently unit-testable.
 *
 * The banner never blocks the donate flow: donations are signed and
 * submitted directly via Freighter/Horizon, independent of the IndigoPay
 * API, so an open breaker only means degraded project sync/receipts.
 */

import type { BreakerState } from "./apiClient";

export interface ApiStatusDescription {
  variant: "degraded" | "connecting";
  text: string;
  showRetry: boolean;
}

/** Map a breaker state to banner copy, or null when nothing should show. */
export function describeApiStatus(
  state: BreakerState | null | undefined,
): ApiStatusDescription | null {
  if (!state || state === "closed") return null;
  if (state === "open") {
    return {
      variant: "degraded",
      text: "API degraded — retrying automatically. Donations still work.",
      showRetry: true,
    };
  }
  // half_open
  return {
    variant: "connecting",
    text: "Reconnecting to IndigoPay API…",
    showRetry: false,
  };
}

export interface ApiStatusBannerElements {
  banner: HTMLElement;
  text: HTMLElement;
  retryButton?: HTMLElement | null;
}

/** Apply a breaker state to a set of DOM elements matching popup.html's banner. */
export function renderApiStatusBanner(
  elements: ApiStatusBannerElements,
  state: BreakerState | null | undefined,
): void {
  const { banner, text, retryButton } = elements;
  const description = describeApiStatus(state);

  if (!description) {
    banner.className = "api-status-banner hidden";
    return;
  }

  banner.className = `api-status-banner ${description.variant}`;
  text.textContent = description.text;
  retryButton?.classList.toggle("hidden", !description.showRetry);
}

/** Map a background API_STATUS_CHANGED event's `type` field to a BreakerState. */
export function breakerEventTypeToState(eventType: string | undefined): BreakerState {
  if (eventType === "breaker_open") return "open";
  if (eventType === "breaker_half_open") return "half_open";
  return "closed";
}
