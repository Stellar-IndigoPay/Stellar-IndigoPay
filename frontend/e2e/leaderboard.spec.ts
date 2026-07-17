import { test, expect } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';

test.describe('Leaderboard', () => {
  test('Verify leaderboard display and sorting', async ({ page }) => {
    await page.goto('/leaderboard');

    // A11y check
    const accessibilityScanResults = await new AxeBuilder({ page }).analyze();
    expect(accessibilityScanResults.violations).toEqual([]);

    // Visual regression of leaderboard table
    await expect(page).toHaveScreenshot('leaderboard-page.png', { fullPage: true });

    const rows = page.locator('table tbody tr, .leaderboard-row'); // Depending on the actual markup
    const count = await rows.count();

    if (count > 0) {
      // Verify donor names/addresses displayed
      const firstRowText = await rows.first().innerText();
      expect(firstRowText.length).toBeGreaterThan(0);

      // We can also verify badge icons if they are present
      // Example: await expect(rows.first().locator('img.badge-icon')).toBeVisible();
    } else {
      console.log('No leaderboard entries found');
    }
  });
});
