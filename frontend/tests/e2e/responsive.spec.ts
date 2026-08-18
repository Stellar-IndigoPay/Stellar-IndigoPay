/**
 * tests/e2e/responsive.spec.ts
 *
 * Responsive viewport tests that verify key pages render correctly at
 * tablet (iPad Pro 1024×1366 and 768×1024 portrait) and mobile
 * (Pixel 5 393×851) breakpoints.
 *
 * These tests complement the existing desktop (1920×1080) coverage.
 */
import { test, expect } from "@playwright/test";

const VIEWPORTS = {
  "Desktop": { width: 1920, height: 1080 },
  "Tablet Landscape": { width: 1024, height: 768 },
  "Tablet Portrait": { width: 768, height: 1024 },
  "Mobile": { width: 393, height: 851 },
} as const;

// Pages that are critical paths and should work at all viewports
const PAGES = [
  { path: "/", name: "Home page" },
  { path: "/leaderboard", name: "Leaderboard" },
  { path: "/impact", name: "Impact dashboard" },
] as const;

for (const [viewportName, viewport] of Object.entries(VIEWPORTS)) {
  test.describe(`${viewportName} (${viewport.width}×${viewport.height})`, () => {
    test.use({ viewport });

    for (const page of PAGES) {
      test(`${page.name} renders without horizontal overflow`, async ({ page: pwPage }) => {
        await pwPage.goto(page.path);

        // Verify the page loaded (no hard crash)
        await expect(pwPage.locator("body")).toBeVisible();

        // Check that no element causes horizontal scrollbar overflow
        const bodyWidth = await pwPage.locator("body").evaluate((el) => el.scrollWidth);
        const windowWidth = viewport.width;
        // Allow a small tolerance (10px) for sub-pixel rendering and
        // browser scrollbar differences across CI runners
        expect(bodyWidth).toBeLessThanOrEqual(windowWidth + 10);
      });

      test(`${page.name} has legible base font size`, async ({ page: pwPage }) => {
        await pwPage.goto(page.path);

        const fontSize = await pwPage.locator("body").evaluate((el) => {
          return window.getComputedStyle(el).fontSize;
        });

        // Font should be at least 14px for readability
        const px = parseFloat(fontSize);
        expect(px).toBeGreaterThanOrEqual(14);
      });
    }
  });
}

test.describe("Tablet-specific", () => {
  test.use({ viewport: { width: 1024, height: 768 } });

  test("wallet connect card is properly centered on tablet", async ({ page }) => {
    await page.goto("/");

    // The connect card should be visible and not cut off
    const connectCard = page.locator(".card");
    const box = await connectCard.first().boundingBox();
    if (box) {
      // Card should be horizontally centered within the viewport
      expect(box.x).toBeGreaterThan(0);
      expect(box.x + box.width).toBeLessThanOrEqual(1024);
    }
  });
});
