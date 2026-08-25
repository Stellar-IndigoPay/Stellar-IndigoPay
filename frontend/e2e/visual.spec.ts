import { test, expect } from "@playwright/test";
import { mockFreighterWallet } from "./mocks/wallet";
import { mockBackendAPI, type MockBackendState } from "./mocks/api";
import { mockHorizonAPI } from "./mocks/horizon";
import { FIXTURE_PROJECTS, PRIMARY_PROJECT } from "./fixtures/projects";

// Visual diffing is only meaningful against one rendering engine — running it
// across Chromium/Firefox/WebKit would just compare each browser's own font
// rendering against itself and triple the baseline images to maintain.
// Skipped across multiple browsers to avoid font-rendering diffs.
// Run strictly against chromium.
test.skip(
  ({ browserName }) => browserName !== "chromium",
  "chromium-only",
);

const THEMES = ["light", "dark"] as const;

for (const theme of THEMES) {
  test.describe(`Visual regression (${theme} mode)`, () => {
    test.use({ colorScheme: theme });

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
      await expect(page).toHaveScreenshot(`homepage-${theme}.png`, {
        fullPage: true,
        animations: "disabled",
      });
    });

    test("project detail snapshot", async ({ page }) => {
      await page.goto(`/projects/${PRIMARY_PROJECT.id}`);
      await expect(
        page.getByRole("heading", { name: PRIMARY_PROJECT.name }),
      ).toBeVisible();
      await expect(page).toHaveScreenshot(`project-detail-${theme}.png`, {
        fullPage: true,
        animations: "disabled",
      });
    });

    test("leaderboard snapshot", async ({ page }) => {
      await page.goto("/leaderboard");
      await expect(page.getByRole("heading", { name: "Impact Leaderboard" }).or(page.getByRole("heading", { name: "Leaderboard" }))).toBeVisible();
      await expect(page).toHaveScreenshot(`leaderboard-${theme}.png`, {
        fullPage: true,
        animations: "disabled",
      });
    });

    test("donate snapshot", async ({ page }) => {
      await page.goto(`/donate/${PRIMARY_PROJECT.id}`);
      // Wait for the donate form to render
      await expect(page.getByText("Select Amount").or(page.getByText("Amount"))).toBeVisible();
      await expect(page).toHaveScreenshot(`donate-${theme}.png`, {
        fullPage: true,
        animations: "disabled",
      });
    });

    test("governance snapshot", async ({ page }) => {
      await page.goto("/governance");
      await expect(page.getByRole("heading", { name: "Governance" })).toBeVisible();
      await expect(page).toHaveScreenshot(`governance-${theme}.png`, {
        fullPage: true,
        animations: "disabled",
      });
    });

    test("dashboard snapshot", async ({ page }) => {
      await page.goto("/dashboard");
      await page.getByTestId("wallet-connect-button").click();
      await expect(page.getByTestId("donation-history")).toBeVisible();
      await expect(page).toHaveScreenshot(`dashboard-${theme}.png`, {
        fullPage: true,
        animations: "disabled",
      });
    });
  });
}
