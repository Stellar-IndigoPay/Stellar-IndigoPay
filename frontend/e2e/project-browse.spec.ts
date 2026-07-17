import { test, expect } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';

test.describe('Project Browse', () => {
  test('Browse and filter projects', async ({ page }) => {
    await page.goto('/projects');

    // A11y check
    const accessibilityScanResults = await new AxeBuilder({ page }).analyze();
    expect(accessibilityScanResults.violations).toEqual([]);

    // Filter by category
    const categorySelect = page.locator('select[name="category"]'); // Adjust based on actual UI
    if (await categorySelect.isVisible()) {
      await categorySelect.selectOption('Reforestation');
    }

    // Search by name
    const searchInput = page.getByPlaceholder(/search/i);
    if (await searchInput.isVisible()) {
      await searchInput.fill('Amazon');
    }

    // Check project cards
    const projectCards = page.locator('.project-card');
    const projectCount = await projectCards.count();

    if (projectCount > 0) {
      // Click project
      await projectCards.first().click();

      // Verify detail page loads with sections
      await expect(page.locator('h1')).toBeVisible(); // Project title
      // Verify stats, description, campaigns, etc.
      await expect(page.getByText(/stats/i)).toBeVisible();
      
      // Visual regression of the project card/page
      await expect(page).toHaveScreenshot('project-detail-page.png', { fullPage: true });
    }
  });
});
