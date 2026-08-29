import { defineConfig, devices } from "@playwright/test";

/**
 * playwright.v2.config.ts
 *
 * Issue #1096 — dedicated Playwright config for the V2 money-path suite in
 * `e2e/` (donation preview + offline durability, WCAG a11y scan, visual
 * regression). These specs enable NEXT_PUBLIC_ENABLE_DONATION_V2 via the
 * documented localStorage override and mock the backend/Horizon/wallet with
 * page-level route interception, so they run against the same production
 * build as the legacy `tests/e2e/` suite without needing json-server.
 *
 * Runs on the desktop viewport only: the visual baselines are
 * desktop-sized, and the money-path flows are viewport-agnostic.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: 1,
  use: {
    // 127.0.0.1 explicitly — Node 22+ resolves "localhost" to ::1 (IPv6)
    // while next start binds to 0.0.0.0 (IPv4).
    baseURL: "http://127.0.0.1:3000",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium-desktop",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npm run start",
    url: "http://127.0.0.1:3000",
    // In CI the server is started externally (see .github/workflows/frontend.yml)
    // so Playwright should reuse it instead of starting its own.
    reuseExistingServer: !!process.env.CI,
    timeout: 300_000,
    env: {
      // Tells middleware.ts to skip the upgrade-insecure-requests CSP
      // directive (which would redirect http→https and break the test).
      E2E_TESTING: "true",
      NEXT_PUBLIC_STELLAR_NETWORK: "testnet",
      NEXT_PUBLIC_HORIZON_URL: "https://horizon-testnet.stellar.org",
      NEXT_PUBLIC_API_URL: "http://localhost:4000",
    },
  },
});
