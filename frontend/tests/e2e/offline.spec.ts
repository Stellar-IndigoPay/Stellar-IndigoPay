import { test, expect } from '@playwright/test';
import { mockApi, MOCK_PROJECT } from './fixtures/api';
import { mockFreighter } from './fixtures/freighter';
import { mockHorizon } from './fixtures/horizon';

test.describe('Offline to Online flow', () => {
  test('persists donation when offline and syncs when back online', async ({ page, context }) => {
    await mockFreighter(page);
    await mockHorizon(page);
    await mockApi(page);

    let projectDonations = [
      {
        id: '123',
        projectId: MOCK_PROJECT.id,
        donorAddress: 'G123',
        amountXLM: '5',
        amount: '5',
        currency: 'XLM',
        transactionHash: 'tx_old',
        createdAt: new Date().toISOString(),
      },
    ];

    // Initial donations for project
    await page.route(`**/api/v1/donations/project/${MOCK_PROJECT.id}*`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        json: {
          success: true,
          data: projectDonations,
          nextCursor: null,
        },
      });
    });

    // Mock record donation API
    await page.route('**/api/v1/donations*', async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          json: { success: true, data: { id: 'test-offline-1', status: 'recorded' } },
        });
      } else {
        await route.fallback();
      }
    });

    // 2. Go to project page
    await page.goto(`/projects/${MOCK_PROJECT.id}`);
    
    // Wait for the UI to be ready
    await page.waitForSelector(`text=${MOCK_PROJECT.name}`, { state: 'visible' });

    // 3. Go offline
    await context.setOffline(true);

    // 4. Trigger an offline donation action
    await page.evaluate(async (projectId) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('indigopay-offline-db', 2);
        req.onupgradeneeded = () => {
          const d = req.result;
          if (!d.objectStoreNames.contains('donations')) {
            d.createObjectStore('donations', { keyPath: 'id' });
          }
          if (!d.objectStoreNames.contains('drain-lease')) {
            d.createObjectStore('drain-lease', { keyPath: 'id' });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });

      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('donations', 'readwrite');
        tx.objectStore('donations').add({
          id: 'test-offline-1',
          payload: {
            projectId: projectId,
            donorAddress: 'G456',
            amount: '25',
            currency: 'XLM',
            message: 'Offline test donation',
            transactionHash: 'queued-offline',
          },
          createdAt: new Date().toISOString(),
          status: 'queued',
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });

      db.close();
      window.dispatchEvent(new Event('offline'));
    }, MOCK_PROJECT.id);

    // We check if the UI reflects offline state
    const offlineBanner = page.getByRole('status');
    await expect(offlineBanner).toBeVisible({ timeout: 10000 });

    // Update backend mock to return synced donation upon next fetch
    projectDonations = [
      {
        id: 'test-offline-1',
        projectId: MOCK_PROJECT.id,
        donorAddress: 'G456',
        amountXLM: '25',
        amount: '25',
        currency: 'XLM',
        transactionHash: 'tx_synced',
        createdAt: new Date().toISOString(),
        message: 'Offline test donation',
      },
      ...projectDonations,
    ];

    // 5. Go online
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    
    // 6. Verify the banner is gone
    await expect(offlineBanner).toBeHidden({ timeout: 10000 });
    
    // 7. Verify the sync occurs and the UI is updated.
    await expect(page.locator('text=Offline test donation')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('span').filter({ hasText: '25 XLM' }).first()).toBeVisible({ timeout: 10000 });
  });
});
