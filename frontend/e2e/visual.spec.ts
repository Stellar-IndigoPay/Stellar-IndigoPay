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
    await page
      .locator('[data-testid="wallet-connect-button"][data-wallet-id="freighter"]')
      .click();
    await expect(page.getByTestId("donation-history")).toBeVisible();
    await expect(page).toHaveScreenshot("dashboard.png", {
      fullPage: true,
      animations: "disabled",
    });
  });

  // Issue #1096 shared AC: visual-regression baselines for the donation-flow
  // pages in DARK mode as well as light. The theme is applied pre-hydration
  // via localStorage (the FOUC inline script in _document.tsx reads the same
  // key), so the captured page is the real dark rendering.
  test("project detail snapshot (dark mode)", async ({ page }) => {
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem("stellar-indigopay-theme", "dark");
      } catch {
        // about:blank has no origin — re-set after first load below.
      }
    });
    await page.goto(`/projects/${PRIMARY_PROJECT.id}`);
    await expect(
      page.getByRole("heading", { name: PRIMARY_PROJECT.name }),
    ).toBeVisible();
    // Confirm the theme actually applied before capturing — a silent failure
    // would otherwise baseline the light theme against the dark filename.
    await page.waitForFunction(() =>
      document.documentElement.classList.contains("dark"),
    );
    await expect(page).toHaveScreenshot("project-detail-dark.png", {
      fullPage: true,
      animations: "disabled",
    });
  });
});
