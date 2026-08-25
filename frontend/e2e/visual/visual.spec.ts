import { test, expect } from "@playwright/test";
import { mockFreighterWallet } from "../mocks/wallet";
import { mockBackendAPI, type MockBackendState } from "../mocks/api";
import { mockHorizonAPI } from "../mocks/horizon";
import { FIXTURE_PROJECTS, PRIMARY_PROJECT } from "../fixtures/projects";

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

  const pages = [
    { name: "home", path: "/" },
    { name: "project-detail", path: `/projects/${PRIMARY_PROJECT.id}` },
    { name: "leaderboard", path: "/leaderboard" },
    { name: "donate", path: "/donate" },
    { name: "governance", path: "/governance" },
    { name: "dashboard", path: "/dashboard" },
  ];

  for (const p of pages) {
    test.describe(`${p.name} page`, () => {
      test("light mode", async ({ page }) => {
        await page.emulateMedia({ colorScheme: "light" });
        await page.goto(p.path);
        
        // Let the animated stat counters (useCountUp) finish before capturing.
        await page.waitForTimeout(3500);

        if (p.name === "dashboard") {
            await page.getByTestId("wallet-connect-button").first().click();
            await expect(page.getByTestId("donation-history")).toBeVisible();
        }

        await expect(page).toHaveScreenshot(`${p.name}-light.png`, {
          fullPage: true,
          animations: "disabled",
        });
      });

      test("dark mode", async ({ page }) => {
        await page.emulateMedia({ colorScheme: "dark" });
        await page.goto(p.path);
        
        // Let the animated stat counters (useCountUp) finish before capturing.
        await page.waitForTimeout(3500);

        if (p.name === "dashboard") {
            await page.getByTestId("wallet-connect-button").first().click();
            await expect(page.getByTestId("donation-history")).toBeVisible();
        }

        await expect(page).toHaveScreenshot(`${p.name}-dark.png`, {
          fullPage: true,
          animations: "disabled",
        });
      });
    });
  }
});
