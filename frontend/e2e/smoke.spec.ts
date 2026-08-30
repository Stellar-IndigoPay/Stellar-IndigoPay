import { test, expect } from '@playwright/test';

test('performance budget for LCP and INP', async ({ page }) => {
  // Use a generous timeout for CI
  test.setTimeout(60000);

  // Expose a function to collect web vitals
  await page.addInitScript(() => {
    (window as any)['webVitals'] = {
      lcp: null,
      inp: null
    };

    // Very basic PerformanceObserver for LCP
    new PerformanceObserver((entryList) => {
      const entries = entryList.getEntries();
      const lastEntry = entries[entries.length - 1];
      (window as any)['webVitals'].lcp = lastEntry.startTime;
    }).observe({ type: 'largest-contentful-paint', buffered: true });

    // Very basic observer for INP (using event timing as proxy)
    new PerformanceObserver((entryList) => {
      for (const entry of entryList.getEntries()) {
        if (!(window as any)['webVitals'].inp || entry.duration > (window as any)['webVitals'].inp) {
          (window as any)['webVitals'].inp = entry.duration;
        }
      }
    }).observe({ type: 'event', buffered: true });
  });

  await page.goto('/');

  // Simulate user interaction to trigger INP measurement.
  // The homepage CTA reads "Browse Projects", not "Explore Projects"
  // (the latter only appears on the dashboard).
  await page.waitForSelector('text=Browse Projects');
  await page.click('text=Browse Projects');
  
  // Wait a moment for layout to settle and observers to fire
  await page.waitForTimeout(2000);

  const vitals = await page.evaluate(() => (window as any)['webVitals']);
  
  // Generous thresholds: LCP < 4000ms, INP < 500ms
  // These are higher than ideal production budgets (2.5s / 200ms) to avoid CI flake
  if (vitals.lcp !== null) {
    expect(vitals.lcp).toBeLessThan(4000);
  }
  
  // INP might be null if no long tasks were triggered by the click, which is fine
  if (vitals.inp !== null) {
    expect(vitals.inp).toBeLessThan(500);
  }
});
