import { test, expect } from "@playwright/test";
import { mockFreighter } from "./fixtures/freighter";
import { mockHorizon } from "./fixtures/horizon";
import { mockApi } from "./fixtures/api";

test("admin login and platform analytics display", async ({ page }) => {
  await mockFreighter(page);
  await mockHorizon(page);
  await mockApi(page);

  page.on("console", msg => console.log("BROWSER CONSOLE:", msg.text()));
  page.on("pageerror", err => console.log("BROWSER PAGEERROR:", err.message));

  // 1. Navigate to admin login page
  await page.goto("/admin/login", { timeout: 60000 });
  await expect(page.locator("h1")).toContainText("Admin Login");

  // 2. Fill in admin credentials
  await page.fill("#username", "admin", { force: true });
  await page.fill("#password", "adminpass", { force: true });

  // 3. Submit login credentials and verify redirection to verification page
  await page.click('button[type="submit"]', { force: true });
  await page.waitForURL(/\/admin\/verification/);

  // 4. Navigate to admin analytics page
  await page.goto("/admin/analytics", { timeout: 60000 });

  // 5. Connect admin wallet (if not already auto-connected on mount)
  const connectButton = page.locator('[data-testid="wallet-connect-button"]').filter({ visible: true }).first();
  if (await connectButton.isVisible()) {
    await connectButton.click();
  }

  // 6. Verify analytics dashboard headers and metrics are displayed
  await expect(page.locator("h1")).toContainText("Analytics Dashboard");
  await expect(page.locator("text=Total Raised").first()).toBeVisible();
  await expect(page.locator("text=Total Donors").first()).toBeVisible();
  await expect(page.locator("text=Total Projects").first()).toBeVisible();

  // 7. Verify charts are rendered correctly on the dashboard
  await expect(page.locator(".recharts-wrapper").first()).toBeVisible();
});
