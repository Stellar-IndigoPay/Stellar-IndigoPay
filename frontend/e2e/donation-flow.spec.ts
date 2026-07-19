import { test, expect, type Locator, type TestInfo } from "@playwright/test";
import { mockFreighterWallet, MOCK_PUBLIC_KEY } from "./mocks/wallet";
import { mockBackendAPI, type MockBackendState } from "./mocks/api";
import { mockHorizonAPI } from "./mocks/horizon";
import { FIXTURE_PROJECTS, PRIMARY_PROJECT } from "./fixtures/projects";

// WebKit's actionability check treats permanently-looping CSS animations
// elsewhere on the page (e.g. the homepage badge's animate-pulse dot) as the
// whole page never being "stable" and hangs indefinitely on click, even
// though the actual target is static — bypass the check there only.
// Forcing on Chromium/Firefox is actively harmful (verified: it lets clicks
// fire before React's handlers are attached, causing real flakiness), so
// this stays scoped to WebKit specifically rather than applied everywhere.
function click(locator: Locator, testInfo: TestInfo) {
  return locator.click({ force: testInfo.project.name === "webkit" });
}

test.describe("Donation flow", () => {
  let backend: MockBackendState;

  test.beforeEach(async ({ page }) => {
    test.slow();
    backend = { projects: structuredClone(FIXTURE_PROJECTS), donations: [] };
    await mockFreighterWallet(page);
    await mockBackendAPI(page, backend);
    await mockHorizonAPI(page);
  });

  test("connect wallet, browse projects, donate, and see impact on the dashboard", async ({
    page,
  }, testInfo) => {
    // 1. Homepage loads.
    await page.goto("/");
    await expect(page.locator("h1")).toContainText("Fund the planet.");

    // 2. Connect wallet from the hero CTA.
    await click(page.getByTestId("start-donating-button"), testInfo);
    await expect(page.getByTestId("wallet-connect-button").first()).toBeVisible();
    await click(page.getByTestId("wallet-connect-button").first(), testInfo);
    await expect(page.getByTestId("browse-projects-link")).toBeVisible();
    await page.waitForTimeout(500);

    // 3. Browse projects.
    await click(page.getByTestId("browse-projects-link"), testInfo);
    await page.waitForURL("**/projects");
    await expect(page.getByTestId("project-card").first()).toBeVisible();

    // 4. Open the first project's detail page.
    await click(page.getByTestId("project-card").first(), testInfo);
    await page.waitForURL(`**/projects/${PRIMARY_PROJECT.id}`);
    await expect(
      page.getByRole("heading", { name: PRIMARY_PROJECT.name }),
    ).toBeVisible();

    // 5. Connect wallet again (each page tracks its own connection state)
    // and donate.
    await click(page.getByTestId("wallet-connect-button").last(), testInfo);
    await expect(page.getByTestId("donation-amount")).toBeVisible();
    await page.getByTestId("donation-amount").fill("50");
    await click(page.getByTestId("donate-button"), testInfo);

    // 6. Verify success confirmation.
    await expect(page.getByTestId("donation-success")).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByTestId("donation-success")).toContainText(
      PRIMARY_PROJECT.name,
    );

    // 7. Navigate to the dashboard and verify the donation appears.
    try {
      await page.goto("/dashboard");
    } catch (e) {
      await page.goto("/dashboard");
    }
    await click(page.getByTestId("wallet-connect-button").first(), testInfo);
    await expect(page.getByTestId("wallet-address")).toBeVisible();
    await expect(page.getByTestId("donation-history")).toBeVisible();
    await expect(page.getByTestId("donation-history")).not.toContainText(
      "No donations yet",
    );
  });

  test("shows a validation hint below the minimum donation amount", async ({
    page,
  }, testInfo) => {
    await page.goto(`/projects/${PRIMARY_PROJECT.id}`);
    await click(page.getByTestId("wallet-connect-button").last(), testInfo);
    await expect(page.getByTestId("donation-amount")).toBeVisible();

    await page.getByTestId("donation-amount").fill("0");
    await expect(page.getByText(/Minimum donation is 1/)).toBeVisible();
    await expect(page.getByTestId("donate-button")).toBeDisabled();
  });

  test("records the connected donor's public key on the recorded donation", async ({
    page,
  }, testInfo) => {
    await page.goto(`/projects/${PRIMARY_PROJECT.id}`);
    await click(page.getByTestId("wallet-connect-button").last(), testInfo);
    await page.getByTestId("donation-amount").fill("25");
    await click(page.getByTestId("donate-button"), testInfo);

    await expect(page.getByTestId("donation-success")).toBeVisible({
      timeout: 15000,
    });
    expect(backend.donations).toHaveLength(1);
    expect(backend.donations[0].donorAddress).toBe(MOCK_PUBLIC_KEY);
    expect(backend.donations[0].projectId).toBe(PRIMARY_PROJECT.id);
  });
});
