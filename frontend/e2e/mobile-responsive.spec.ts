import { test, expect } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';

// Explicitly use a mobile viewport for this test block
test.use({ viewport: { width: 375, height: 812 } });

test.describe('Mobile Responsive', () => {
  test('Verify mobile navigation and layout', async ({ page }) => {
    await page.goto('/');

    // A11y check
    const accessibilityScanResults = await new AxeBuilder({ page }).analyze();
    expect(accessibilityScanResults.violations).toEqual([]);

    // Hamburger menu toggle
    const menuButton = page.getByRole('button', { name: /menu|open/i });
    if (await menuButton.isVisible()) {
      await menuButton.click();
      // Verify mobile nav opens
      await expect(page.getByRole('navigation').last()).toBeVisible();
      // Close menu
      const closeButton = page.getByRole('button', { name: /close/i }).first();
      if (await closeButton.isVisible()) {
        await closeButton.click();
      }
    }

    // Verify project cards layout on mobile (stacked)
    await page.goto('/projects');
    const firstCard = page.locator('.project-card').first();
    const secondCard = page.locator('.project-card').nth(1);
    
    if (await firstCard.isVisible() && await secondCard.isVisible()) {
      const box1 = await firstCard.boundingBox();
      const box2 = await secondCard.boundingBox();
      
      // On mobile, they should be stacked vertically
      if (box1 && box2) {
        expect(box2.y).toBeGreaterThan(box1.y + box1.height - 10);
      }
    }

    // Test donation form layout
    if (await firstCard.isVisible()) {
      await firstCard.click();
      const amountInput = page.getByPlaceholder(/amount/i);
      await expect(amountInput).toBeVisible();
      // Ensure the donate button is clickable and visible in viewport
      const donateButton = page.getByRole('button', { name: /donate/i });
      await donateButton.scrollIntoViewIfNeeded();
      await expect(donateButton).toBeVisible();
    }
  });
});
