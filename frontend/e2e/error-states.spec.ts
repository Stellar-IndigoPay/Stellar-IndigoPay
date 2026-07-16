import { test, expect } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';

test.describe('Error States', () => {
  test('Test 404 page', async ({ page }) => {
    // Navigate to a non-existent route
    const response = await page.goto('/this-page-does-not-exist');
    expect(response?.status()).toBe(404);

    // Verify 404 text
    await expect(page.getByText(/404/i).first()).toBeVisible();
    await expect(page.getByText(/not found/i).first()).toBeVisible();

    // A11y check
    const accessibilityScanResults = await new AxeBuilder({ page }).analyze();
    expect(accessibilityScanResults.violations).toEqual([]);
  });

  test('Network error handling', async ({ page }) => {
    // Mock the API to return a 500 error
    await page.route('**/api/projects*', async route => {
      await route.fulfill({ status: 500, body: 'Internal Server Error' });
    });

    await page.goto('/projects');
    
    // Check if error boundary or toast displays the error
    // Could be a toast, a retry button, or a generic error message
    const errorMessage = page.locator('text=/error|failed to load/i');
    await expect(errorMessage.first()).toBeVisible();
  });
});
