import type { Page } from "@playwright/test";

export const MOCK_PUBLIC_KEY = "GCEZWKW744OREGLTR6Q6ZYITK5GSBVC3XRONSIJSBTRSCGNFAVSBXP33";

/**
 * Inject a connected-wallet state into the IndigoPay frontend for E2E tests.
 * This sets the global `window.__test_publicKey__` seam which is intercepted
 * by the application's wallet helper module to skip real extension calls.
 */
export async function mockFreighter(page: Page, publicKey = MOCK_PUBLIC_KEY) {
  await page.addInitScript((pk) => {
    (window as any).__test_publicKey__ = pk;
    (window as any).freighter = {
      isConnected: () => Promise.resolve({ isConnected: true }),
      isAllowed: () => Promise.resolve({ isAllowed: true }),
      getPublicKey: () => Promise.resolve({ publicKey: pk, address: pk }),
      requestAccess: () => Promise.resolve({ address: pk }),
      signTransaction: (xdr: string) => Promise.resolve({ signedTransaction: xdr }),
      getNetwork: () => Promise.resolve("TESTNET"),
    };
  }, publicKey);
}
