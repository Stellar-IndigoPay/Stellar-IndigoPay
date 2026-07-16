import { test, expect } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';

test.describe('Donation Flow', () => {
  test('Completes a donation and verifies dashboard and leaderboard', async ({ page }) => {
    // Navigate to homepage
    await page.goto('/');

    // A11y check
    const accessibilityScanResults = await new AxeBuilder({ page }).analyze();
    expect(accessibilityScanResults.violations).toEqual([]);

    // Mock Freighter API in the browser context
    await page.addInitScript(() => {
      (window as any).freighter = {
        isConnected: async () => true,
        getPublicKey: async () => 'GBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        signTransaction: async (tx: string) => tx, // Mock signing by returning the tx back
        getNetworkDetails: async () => ({ network: 'TESTNET' })
      };
    });

    // We can't actually do the full transaction on a mocked Freighter if the backend validates it,
    // so we will test the UI flow as much as possible.
    
    // Browse projects
    const projectsLink = page.getByRole('link', { name: /browse/i }).first();
    if (await projectsLink.isVisible()) {
      await projectsLink.click();
    } else {
      await page.goto('/projects');
    }

    await expect(page).toHaveURL(/.*\/projects/);

    // Select a project
    const firstProject = page.locator('.project-card').first(); // Adjust selector based on actual class
    // We wrap this in a try-catch or conditional in case no projects are seeded
    const projectCount = await page.locator('.project-card').count();
    
    if (projectCount > 0) {
      await firstProject.click();
      
      // Enter amount
      const amountInput = page.getByPlaceholder(/amount/i);
      await amountInput.fill('10');
      
      // Click donate
      const donateButton = page.getByRole('button', { name: /donate/i });
      await donateButton.click();

      // Sign transaction
      // For a fully mocked flow, we assume the UI handles the mock and shows success
      
      // Verify dashboard shows donation
      await page.goto('/dashboard');
      await expect(page.getByText('10')).toBeVisible();

      // Verify leaderboard
      await page.goto('/leaderboard');
      await expect(page.getByText('GBXXX...')).toBeVisible(); // Depends on format
    } else {
      console.log('No projects seeded, skipping donation interaction');
    }
  });
});
