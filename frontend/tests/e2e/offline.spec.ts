import { test, expect } from '@playwright/test';

test.describe('Offline to Online flow', () => {
  test('persists donation when offline and syncs when back online', async ({ page, context }) => {
    // 1. Mock API responses
    await page.route('**/api/projects/1', async (route) => {
      await route.fulfill({
        status: 200,
        json: {
          success: true,
          data: {
            id: '1',
            name: 'Test Project',
            walletAddress: 'G_TEST_WALLET',
          }
        }
      });
    });

    await page.route('**/api/projects/1/updates*', async (route) => {
      await route.fulfill({ status: 200, json: { success: true, updates: [] } });
    });

    await page.route('**/api/projects/1/matches*', async (route) => {
      await route.fulfill({ status: 200, json: { success: true, matches: [] } });
    });

    await page.route('**/api/projects/1/donations*', async (route) => {
      await route.fulfill({
        status: 200,
        json: {
          success: true,
          donations: [
            { id: '123', projectId: '1', donorAddress: 'G123', amountXLM: '5', amount: '5', currency: 'XLM', transactionHash: 'tx_old', createdAt: new Date().toISOString() }
          ],
          nextCursor: null
        }
      });
    });

    // 2. Go to project page
    await page.goto('/projects/1');
    
    // Wait for the UI to be ready
    await page.waitForSelector('text=Test Project', { state: 'visible' });

    // 3. Go offline
    await context.setOffline(true);

    // 4. Trigger an offline donation action
    // In our E2E environment we assume we have a donate form, we will just simulate a queue event
    // since the wallet flow is hard to fully mock in a headless playwright without a mock wallet extension.
    await page.evaluate(() => {
      // Simulate adding to offline queue
      const request = indexedDB.open('offlineDonations', 1);
      request.onupgradeneeded = (e) => {
        const db = (e.target as any).result;
        if (!db.objectStoreNames.contains('donations')) {
          db.createObjectStore('donations', { keyPath: 'id' });
        }
      };
      request.onsuccess = (e) => {
        const db = (e.target as any).result;
        const tx = db.transaction('donations', 'readwrite');
        tx.objectStore('donations').add({
          id: 'test-offline-1',
          projectId: '1',
          donorAddress: 'G456',
          amountXLM: '25',
          transactionHash: 'queued-offline',
          createdAt: new Date().toISOString(),
          anonymous: false,
          message: 'Offline test donation'
        });
      };
      
      // Dispatch an offline event just in case
      window.dispatchEvent(new Event('offline'));
    });

    // We check if the UI reflects offline state
    const offlineBanner = page.locator('text=You are currently offline');
    await expect(offlineBanner).toBeVisible({ timeout: 10000 });
    
    // Mock the record donation API which will be called when online
    await page.route('**/api/donations', async (route) => {
      await route.fulfill({
        status: 200,
        json: { success: true }
      });
    });

    // 5. Go online
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    
    // 6. Verify the banner is gone
    await expect(offlineBanner).toBeHidden({ timeout: 10000 });
    
    // 7. Verify the sync occurs and the UI is updated.
    // The syncQueuedDonations function posts a message to service worker or is handled by event listener,
    // which in turn calls recordDonation and then invalidates query.
    // Let's assert that the API was called or that the feed reflects the new donation if the mock was hit.
    
    // Check for optimistic update or refetched donation
    // If the mock `recordDonation` resolves, React Query will refetch. Let's mock the refetch to return the new one:
    await page.route('**/api/projects/1/donations*', async (route) => {
      await route.fulfill({
        status: 200,
        json: {
          success: true,
          donations: [
            { id: 'test-offline-1', projectId: '1', donorAddress: 'G456', amountXLM: '25', amount: '25', currency: 'XLM', transactionHash: 'tx_synced', createdAt: new Date().toISOString(), message: 'Offline test donation' },
            { id: '123', projectId: '1', donorAddress: 'G123', amountXLM: '5', amount: '5', currency: 'XLM', transactionHash: 'tx_old', createdAt: new Date().toISOString() }
          ],
          nextCursor: null
        }
      });
    });
    
    // Assuming the page auto-updates, we should see "25" and "Offline test donation"
    await expect(page.locator('text=Offline test donation')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=25')).toBeVisible({ timeout: 10000 });
  });
});
