import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  retries: 1,
  use: {
    // Use 127.0.0.1 explicitly — Node 22+ resolves "localhost" to ::1 (IPv6)
    // while next start binds to 0.0.0.0 (IPv4), causing connection-refused timeouts.
    baseURL: "http://127.0.0.1:3000",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium-desktop",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "chromium-tablet",
      use: { ...devices["iPad Pro"] },
    },
    {
      name: "chromium-tablet-portrait",
      use: { ...devices["iPad Pro"], viewport: { width: 768, height: 1024 } },
    },
    {
      name: "chromium-mobile",
      use: { ...devices["Pixel 5"] },
    },
  ],
  webServer: {
    command: "npm run start",
    // 127.0.0.1 avoids IPv4/IPv6 localhost resolution mismatch on Node 22+.
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
