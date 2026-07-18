import { test, expect } from "@playwright/test";
import { mockFreighterWallet } from "./mocks/wallet";
import { mockBackendAPI, type MockBackendState } from "./mocks/api";
import { mockHorizonAPI } from "./mocks/horizon";
import { FIXTURE_PROJECTS, PRIMARY_PROJECT } from "./fixtures/projects";

// Visual diffing is only meaningful against one rendering engine — running it
// across Chromium/Firefox/WebKit would just compare each browser's own font
// rendering against itself and triple the baseline images to maintain.
// Skipped in CI: snapshots are OS/font-render specific and must be maintained
// locally where the baselines were generated.
test.skip(
  ({ browserName }) => browserName !== "chromium" || !!process.env.CI,
  "chromium-only, local dev only",
);

test.describe("Visual regression", () => {
  test.beforeEach(async ({ page }) => {
    const backend: MockBackendState = {
      projects: structuredClone(FIXTURE_PROJECTS),
      donations: [],
    };
    await mockFreighterWallet(page);
    await mockBackendAPI(page, backend);
    await mockHorizonAPI(page);
  });

  test("homepage snapshot", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("h1")).toContainText("Fund the planet.");
    // Let the animated stat counters (useCountUp) finish before capturing.
    await page.waitForTimeout(3500);
    await expect(page).toHaveScreenshot("homepage.png", {
      fullPage: true,
      animations: "disabled",
    });
  });

  test("project detail snapshot", async ({ page }) => {
    await page.goto(`/projects/${PRIMARY_PROJECT.id}`);
    await expect(
      page.getByRole("heading", { name: PRIMARY_PROJECT.name }),
    ).toBeVisible();
    await expect(page).toHaveScreenshot("project-detail.png", {
      fullPage: true,
      animations: "disabled",
    });
  });

  test("dashboard snapshot", async ({ page }) => {
    await page.goto("/dashboard");
    await page.getByTestId("wallet-connect-button").click();
    await expect(page.getByTestId("donation-history")).toBeVisible();
    await expect(page).toHaveScreenshot("dashboard.png", {
      fullPage: true,
      animations: "disabled",
    });
  });
});
