import { test, expect } from "@playwright/test";
import { mockFreighter } from "./fixtures/freighter";
import { mockHorizon } from "./fixtures/horizon";
import { mockApi } from "./fixtures/api";

test("complete donation flow: browse → donate", async ({ page }) => {
  await mockFreighter(page);
  await mockHorizon(page);
  await mockApi(page);

  page.on("console", msg => console.log("BROWSER CONSOLE:", msg.text()));
  page.on("pageerror", err => console.log("BROWSER PAGEERROR:", err.message));
  page.on("request", request => console.log(">> REQUEST:", request.method(), request.url()));
  page.on("requestfailed", request => console.log("xx REQUEST FAILED:", request.url(), request.failure()?.errorText));
  page.on("response", response => console.log("<< RESPONSE:", response.status(), response.url()));

  // 1. Navigate to projects listing
  await page.goto("/projects", { timeout: 60000 });
  await expect(page.locator("h1")).toContainText("Climate Projects");

  // 2. Click on the first project card
  await page.locator('[data-testid="project-card"]').first().click();
  await page.waitForURL(/\/projects\//);

  // 3. Connect wallet on project detail page
  await page.locator('[data-testid="wallet-connect-button"]').filter({ visible: true }).first().click();
  await expect(page.locator('[data-testid="donation-amount"]')).toBeVisible();

  // 4. Enter donation amount
  await page.fill('[data-testid="donation-amount"]', "50");

  // 5. Click Donate
  await page.click('[data-testid="donate-button"]');

  // 6. Verify success confirmation screen is displayed
  await expect(page.locator('[data-testid="donation-success"]')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('[data-testid="donation-success"]')).toContainText("50 XLM");
});
