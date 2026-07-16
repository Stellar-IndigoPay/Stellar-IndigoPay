import { test, expect } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';

test.describe('Governance', () => {
  test('View and vote on proposals', async ({ page }) => {
    await page.goto('/governance');

    // A11y check
    const accessibilityScanResults = await new AxeBuilder({ page }).analyze();
    expect(accessibilityScanResults.violations).toEqual([]);

    const hasProposals = await page.locator('.proposal-card').count() > 0;
    
    if (hasProposals) {
      // Visual regression of governance page with proposals
      await expect(page).toHaveScreenshot('governance-proposals.png', { fullPage: true });

      const firstProposal = page.locator('.proposal-card').first();
      await firstProposal.click();

      // Ensure we are on the proposal detail page
      await expect(page.url()).toMatch(/\/governance\/.+/);

      // Mock wallet if required to vote
      await page.addInitScript(() => {
        (window as any).freighter = {
          isConnected: async () => true,
          getPublicKey: async () => 'GBXXX_GOVERNANCE',
          signTransaction: async (tx: string) => tx,
        };
      });

      const voteButton = page.getByRole('button', { name: /vote/i }).first();
      
      if (await voteButton.isVisible() && await voteButton.isEnabled()) {
        await voteButton.click();
        
        // Wait for vote count to change or success message
        await expect(page.getByText(/vote recorded|success/i)).toBeVisible();
        
        // Verify "Already voted" message on re-vote attempt
        await expect(page.getByText(/already voted/i)).toBeVisible();
      }
    } else {
      console.log('No proposals found, skipping governance interaction');
    }
  });
});
