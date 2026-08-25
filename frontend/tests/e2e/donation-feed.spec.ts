import { test, expect } from "@playwright/test";
import { mockFreighter } from "./fixtures/freighter";
import { mockHorizon } from "./fixtures/horizon";
import { mockApi, MOCK_PROJECT } from "./fixtures/api";

/**
 * E2E test for the virtualized donation feed (GrantFox #1130 / #1025):
 * verifies that scrolling the feed to the bottom triggers the cursor-based
 * infinite scroll and renders the next (older) page of donations.
 */
const PROJECT_ID = MOCK_PROJECT.id;

function makeDonation(id: string, amountXLM: number, message?: string) {
  return {
    id,
    projectId: PROJECT_ID,
    donorAddress: "GCEZWKW744OREGLTR6Q6ZYITK5GSBVC3XRONSIJSBTRSCGNFAVSBXP33",
    amountXLM: String(amountXLM),
    currency: "XLM",
    message,
    transactionHash: `0000000000000000000000000000000000000000000000000000000000000${amountXLM}`.slice(
      -64,
    ),
    createdAt: `2026-07-${String(amountXLM).padStart(2, "0")}T12:00:00Z`,
  };
}

test("donation feed loads older pages via infinite scroll", async ({ page }) => {
  await mockFreighter(page);
  await mockHorizon(page);
  await mockApi(page);

  // Cursor-paginated donations endpoint: page 1 (newest) with a cursor,
  // page 2 (older) without one. The unique message marks a page-2 row.
  const pageOne = Array.from({ length: 10 }, (_, i) =>
    makeDonation(`page1-${i}`, i + 1),
  );
  const pageTwo = Array.from({ length: 10 }, (_, i) =>
    makeDonation(`page2-${i}`, i + 11),
  );
  pageTwo[0].message = "Older page loaded via infinite scroll";

  await page.route(/\/api\/v1\/donations\/project\//, (route) => {
    const url = new URL(route.request().url());
    const cursor = url.searchParams.get("cursor");
    const body =
      cursor === "cursor-page-2"
        ? { success: true, data: pageTwo, nextCursor: null }
        : { success: true, data: pageOne, nextCursor: "cursor-page-2" };
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });

  await page.goto(`/projects/${PROJECT_ID}`, { timeout: 60000 });

  const feed = page.locator('[data-testid="donation-feed-scroll"]');
  await expect(feed).toBeVisible({ timeout: 20000 });

  // The newest donation (page 1) renders first.
  await expect(feed.getByRole("listitem").first()).toContainText("1 XLM");

  // Page 2 must not have loaded yet.
  await expect(
    page.getByText("Older page loaded via infinite scroll"),
  ).toHaveCount(0);

  // Scroll to the bottom of the feed to trigger the infinite-scroll load.
  await feed.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    el.dispatchEvent(new Event("scroll"));
  });

  // The next (older) page is now fetched and rendered.
  await expect(
    page.getByText("Older page loaded via infinite scroll"),
  ).toBeVisible({ timeout: 10000 });
});
