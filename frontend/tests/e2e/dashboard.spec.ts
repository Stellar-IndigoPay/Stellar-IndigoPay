import { test, expect } from "@playwright/test";
import { mockFreighter } from "./fixtures/freighter";
import { mockHorizon } from "./fixtures/horizon";
import { mockApi } from "./fixtures/api";

test("wallet connect and display user stats on dashboard", async ({ page }) => {
  await mockFreighter(page);
  await mockHorizon(page);
  await mockApi(page);

  // 1. Navigate to donor dashboard
  await page.goto("/dashboard", { timeout: 60000 });
  await expect(page.locator("h1")).toContainText("My Impact");

  // 2. Verify WalletConnect prompt is displayed when wallet is not connected
  await expect(page.locator('[data-testid="wallet-connect-button"]')).toBeVisible();

  // 3. Connect Freighter wallet
  await page.click('[data-testid="wallet-connect-button"]');

  // 4. Verify wallet address is displayed on the dashboard
  await expect(page.locator('[data-testid="wallet-address"]')).toBeVisible();
  await expect(page.locator('[data-testid="wallet-address"]')).toContainText("GCEZW");

  // 5. Verify stats / metrics cards are rendered
  await expect(page.locator("text=Total Donated").first()).toBeVisible();
  await expect(page.locator("text=Est. CO₂ Offset").first()).toBeVisible();

  // 6. Verify donation history list is populated
  await expect(page.locator('[data-testid="donation-history"]')).toBeVisible();
  await expect(page.locator("text=Project donation").first()).toBeVisible();
});
