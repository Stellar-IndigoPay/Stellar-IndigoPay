/**
 * lib/featureFlags.ts — rollout gates for frontend features.
 *
 * The donation money-path hardening (issue #1096) is delivered as one PR
 * behind a single shared flag so the existing /donate flow keeps serving
 * users untouched until the new flow is verified in production.
 *
 *   NEXT_PUBLIC_ENABLE_DONATION_V2=true  →  new flow active
 *   unset / "false"                       →  legacy flow (default)
 *
 * E2E override: Playwright sets `indigopay-donation-v2` in localStorage
 * before page load to exercise the V2 flow against the same build that runs
 * the legacy E2E suite (the flag is a build-time env var, so it cannot be
 * toggled per-test otherwise).  The override only enables the flag for the
 * individual browser session that sets it — it never affects other users.
 */

export const ENABLE_DONATION_V2 =
  process.env.NEXT_PUBLIC_ENABLE_DONATION_V2 === "true" ||
  (typeof window !== "undefined" &&
    typeof window.localStorage !== "undefined" &&
    window.localStorage.getItem("indigopay-donation-v2") === "true");
