import type { Page, Route } from "@playwright/test";

/**
 * Mock Stellar Horizon and Soroban RPC API calls using Playwright network interception.
 */
export async function mockHorizon(page: Page) {
  // Mock Horizon Accounts endpoint (GET)
  await page.route("**/horizon-testnet.stellar.org/accounts/**", (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "GCEZWKW744OREGLTR6Q6ZYITK5GSBVC3XRONSIJSBTRSCGNFAVSBXP33",
        account_id: "GCEZWKW744OREGLTR6Q6ZYITK5GSBVC3XRONSIJSBTRSCGNFAVSBXP33",
        sequence: "123456",
        balances: [
          {
            asset_type: "native",
            balance: "5000.0000000",
          },
        ],
        thresholds: { low_threshold: 1, med_threshold: 1, high_threshold: 1 },
        flags: { auth_required: false, auth_revocable: false, auth_immutable: false }
      }),
    });
  });

  // Mock Horizon Transaction Submission endpoint (POST)
  await page.route("**/horizon-testnet.stellar.org/transactions", (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        hash: "abc123def456abc123def456abc123def456abc123def456abc123def456abc1",
        ledger: 12345,
        successful: true,
      }),
    });
  });

  // Mock Soroban RPC Endpoint (POST)
  await page.route("**/soroban-testnet.stellar.org/**", (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          status: "SUCCESS",
          results: [],
        },
      }),
    });
  });
}
