/**
 * e2e/wallet-adapters.spec.ts
 *
 * Issue #1096, Workstream 4 (multi-wallet support) E2E coverage. Proves the
 * donation money path works identically regardless of which wallet adapter
 * the donor connects with — not just the Freighter extension:
 *
 *  1. Albedo — connect with the mocked popup postMessage protocol, sign, and
 *     verify the donation is recorded with the Albedo public key.
 *  2. WalletConnect — connect through the mocked QR-pairing flow (the adapter
 *     short-circuits via `window.__walletconnect_test_pubkey__`, mirroring
 *     Freighter's `__test_publicKey__` hook), sign, and verify the donation
 *     is recorded.
 *
 * The V2 flow is gated by NEXT_PUBLIC_ENABLE_DONATION_V2, so these tests
 * enable it per-session via the documented localStorage override (see
 * lib/featureFlags.ts) — the same build that runs donation-flow.spec.ts.
 */
import { test, expect, type Locator, type TestInfo } from "@playwright/test";
import {
  mockAlbedoWallet,
  mockFreighterWallet,
  MOCK_PUBLIC_KEY,
} from "./mocks/wallet";
import { mockBackendAPI, type MockBackendState } from "./mocks/api";
import { mockHorizonAPI } from "./mocks/horizon";
import { FIXTURE_PROJECTS, PRIMARY_PROJECT } from "./fixtures/projects";

function click(locator: Locator, testInfo: TestInfo) {
  return locator.click({ force: testInfo.project.name === "webkit" });
}

test.describe("Donation flow — multi-wallet (Albedo + WalletConnect)", () => {
  let backend: MockBackendState;

  test.beforeEach(async ({ page }) => {
    test.slow();
    backend = { projects: structuredClone(FIXTURE_PROJECTS), donations: [] };

    // Enable the V2 flow for this session.
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem("indigopay-donation-v2", "true");
      } catch {
        // about:blank has no origin — the flag is re-set after first load.
      }
    });

    await mockBackendAPI(page, backend);
    await mockHorizonAPI(page);

    // Ensure the localStorage override is definitely set on the app origin.
    await page.goto("/");
    await page.evaluate(() =>
      window.localStorage.setItem("indigopay-donation-v2", "true"),
    );
  });

  test("connects with Albedo, signs, and records the donation (mock popup)", async ({
    page,
  }, testInfo) => {
    await mockAlbedoWallet(page);

    await page.goto(`/projects/${PRIMARY_PROJECT.id}`);
    await click(
      page
        .locator('[data-testid="wallet-connect-button"][data-wallet-id="albedo"]')
        .last(),
      testInfo,
    );
    await expect(page.getByTestId("donation-amount")).toBeVisible();

    await page.getByTestId("donation-amount").fill("40");
    await click(page.getByTestId("donate-button"), testInfo);

    // No blind signing: the preview appears before any wallet prompt.
    await expect(page.getByTestId("transaction-preview")).toBeVisible();
    await expect(page.getByTestId("preview-amount")).toContainText("40 XLM");

    await click(page.getByTestId("preview-confirm-checkbox"), testInfo);
    await click(page.getByTestId("preview-confirm-button"), testInfo);

    // Signed through the Albedo adapter and recorded with the Albedo key.
    await expect(page.getByTestId("donation-success")).toBeVisible({
      timeout: 15000,
    });
    await expect
      .poll(() => backend.donations.length, { timeout: 15000 })
      .toBe(1);
    expect(backend.donations[0].donorAddress).toBe(MOCK_PUBLIC_KEY);
  });

  test("pairs a WalletConnect wallet (mock QR flow), signs, and records the donation", async ({
    page,
  }, testInfo) => {
    // Short-circuit the WalletConnect adapter (QR pairing → session) with the
    // deterministic fixture key, mirroring Freighter's __test_publicKey__ hook.
    await page.addInitScript(({ publicKey }) => {
      (window as unknown as { __walletconnect_test_pubkey__: string })
        .__walletconnect_test_pubkey__ = publicKey;
    }, { publicKey: MOCK_PUBLIC_KEY });

    await page.goto(`/projects/${PRIMARY_PROJECT.id}`);

    // WalletConnect is always "available" (QR pairing needs no install), so it
    // appears in the picker alongside any detected extension.
    await click(
      page
        .locator('[data-testid="wallet-connect-button"][data-wallet-id="walletConnect"]')
        .last(),
      testInfo,
    );
    await expect(page.getByTestId("donation-amount")).toBeVisible();

    await page.getByTestId("donation-amount").fill("30");
    await click(page.getByTestId("donate-button"), testInfo);

    await expect(page.getByTestId("transaction-preview")).toBeVisible();
    await click(page.getByTestId("preview-confirm-checkbox"), testInfo);
    await click(page.getByTestId("preview-confirm-button"), testInfo);

    await expect(page.getByTestId("donation-success")).toBeVisible({
      timeout: 15000,
    });
    await expect
      .poll(() => backend.donations.length, { timeout: 15000 })
      .toBe(1);
    expect(backend.donations[0].donorAddress).toBe(MOCK_PUBLIC_KEY);
  });

  test("switching wallets mid-session: disconnect Freighter, connect WalletConnect, donation still records", async ({
    page,
  }, testInfo) => {
    // Session A: connect Freighter and verify the selection is persisted.
    await mockFreighterWallet(page);
    await page.addInitScript(({ publicKey }) => {
      (window as unknown as { __walletconnect_test_pubkey__: string })
        .__walletconnect_test_pubkey__ = publicKey;
    }, { publicKey: MOCK_PUBLIC_KEY });

    await page.goto(`/projects/${PRIMARY_PROJECT.id}`);
    await click(
      page
        .locator('[data-testid="wallet-connect-button"][data-wallet-id="freighter"]')
        .last(),
      testInfo,
    );
    await expect(page.getByTestId("donation-amount")).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => window.localStorage.getItem("indigopay_wallet_id")),
      )
      .toBe("freighter");

    // Mid-session switch: WalletProvider.disconnect() clears the stored
    // preference (clearWalletSelection) and returns to the picker.  With the
    // Freighter selection forgotten, the picker re-detects and WalletConnect
    // (always available) is connected next — the DonateForm must sign through
    // the NEW adapter and record the donation.
    await page.evaluate(() => {
      window.localStorage.removeItem("indigopay_wallet_id");
    });
    await page.reload();
    await click(
      page
        .locator('[data-testid="wallet-connect-button"][data-wallet-id="walletConnect"]')
        .last(),
      testInfo,
    );
    await expect(page.getByTestId("donation-amount")).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => window.localStorage.getItem("indigopay_wallet_id")),
      )
      .toBe("walletConnect");

    await page.getByTestId("donation-amount").fill("20");
    await click(page.getByTestId("donate-button"), testInfo);
    await click(page.getByTestId("preview-confirm-checkbox"), testInfo);
    await click(page.getByTestId("preview-confirm-button"), testInfo);

    await expect(page.getByTestId("donation-success")).toBeVisible({
      timeout: 15000,
    });
    await expect
      .poll(() => backend.donations.length, { timeout: 15000 })
      .toBe(1);
    expect(backend.donations[0].donorAddress).toBe(MOCK_PUBLIC_KEY);
  });
});