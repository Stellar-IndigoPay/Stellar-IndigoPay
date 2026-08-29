/**
 * e2e/donation-preview.spec.ts
 *
 * Issue #1096, Workstream 5 + Workstream 2 E2E coverage for the V2 flow:
 *
 *  1. "No blind signing" — the transaction preview renders destination,
 *     amount, fee, and total debited BEFORE any wallet prompt, and a
 *     confirmation checkbox gates the wallet signature.
 *  2. Offline durability — an offline donation is queued with a dismissible
 *     notice while the form stays usable, and on reconnect it is recorded
 *     exactly once (server idempotency pre-check + cross-tab drain lease)
 *     with the queue badge reflecting the pending count.
 *
 * The V2 flow is gated by NEXT_PUBLIC_ENABLE_DONATION_V2 (a build-time env
 * var), so these tests enable it per-session via the documented
 * localStorage override (see lib/featureFlags.ts) — the same build that
 * runs the legacy donation-flow.spec.ts.
 */
import { test, expect, type Locator, type TestInfo } from "@playwright/test";
import type { Donation } from "@/utils/types";
import { mockFreighterWallet } from "./mocks/wallet";
import { mockBackendAPI, type MockBackendState } from "./mocks/api";
import { mockHorizonAPI } from "./mocks/horizon";
import { FIXTURE_PROJECTS, PRIMARY_PROJECT } from "./fixtures/projects";

// WebKit's actionability check treats permanently-looping CSS animations
// elsewhere on the page as the whole page never being "stable" and hangs
// indefinitely on click, even though the actual target is static — bypass
// the check there only (same rationale as donation-flow.spec.ts).
function click(locator: Locator, testInfo: TestInfo) {
  return locator.click({ force: testInfo.project.name === "webkit" });
}

test.describe("Donation flow — V2 (preview + offline durability)", () => {
  let backend: MockBackendState;

  test.beforeEach(async ({ page }) => {
    test.slow();
    backend = { projects: structuredClone(FIXTURE_PROJECTS), donations: [] };

    // Enable the V2 flow for this session and count wallet sign requests so
    // the spec can prove the wallet prompt is gated behind the preview.
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem("indigopay-donation-v2", "true");
      } catch {
        // about:blank has no origin — the flag is re-set after first load.
      }
      (window as unknown as { __signRequestCount__: number }).__signRequestCount__ = 0;
      window.addEventListener("message", (event) => {
        const data = event.data as
          | { source?: string; type?: string }
          | undefined;
        if (
          data &&
          data.source === "FREIGHTER_EXTERNAL_MSG_REQUEST" &&
          data.type === "SUBMIT_TRANSACTION"
        ) {
          (window as unknown as { __signRequestCount__: number }).__signRequestCount__ += 1;
        }
      });
    });

    await mockFreighterWallet(page);
    await mockBackendAPI(page, backend);
    await mockHorizonAPI(page);

    // Ensure the localStorage override is definitely set on the app origin.
    await page.goto("/");
    await page.evaluate(() =>
      window.localStorage.setItem("indigopay-donation-v2", "true"),
    );
  });

  test("shows the transaction preview before any wallet prompt and gates signing on the checkbox", async ({
    page,
  }, testInfo) => {
    await page.goto(`/projects/${PRIMARY_PROJECT.id}`);
    await click(
      page
        .locator('[data-testid="wallet-connect-button"][data-wallet-id="freighter"]')
        .last(),
      testInfo,
    );
    await expect(page.getByTestId("donation-amount")).toBeVisible();

    await page.getByTestId("donation-amount").fill("50");
    await click(page.getByTestId("donate-button"), testInfo);

    // The preview appears with the human-readable summary…
    await expect(page.getByTestId("transaction-preview")).toBeVisible();
    await expect(page.getByTestId("preview-amount")).toContainText("50 XLM");
    await expect(page.getByTestId("preview-total")).toContainText("50 XLM");
    // The destination is shown shortened (e.g. GD6R…RSL) with the full
    // address available on hover (title attribute).
    await expect(page.getByTestId("preview-destination")).toContainText("…");
    await expect(page.getByTestId("preview-destination")).toHaveAttribute(
      "title",
      /^G[A-Z0-9]{55}$/,
    );

    // …and the wallet prompt has NOT fired yet (no blind signing).
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { __signRequestCount__: number })
            .__signRequestCount__,
      ),
    ).toBe(0);

    // The confirm button is gated on the confirmation checkbox.
    const confirmButton = page.getByTestId("preview-confirm-button");
    await expect(confirmButton).toBeDisabled();
    await click(page.getByTestId("preview-confirm-checkbox"), testInfo);
    await expect(confirmButton).toBeEnabled();

    await click(confirmButton, testInfo);

    // Only after explicit confirmation does the wallet get asked to sign,
    // and the donation lands in the success state.
    await expect(page.getByTestId("donation-success")).toBeVisible({
      timeout: 15000,
    });
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { __signRequestCount__: number })
            .__signRequestCount__,
      ),
    ).toBe(1);
    expect(backend.donations).toHaveLength(1);
  });

  test("queues an offline donation and records it exactly once on reconnect", async ({
    page,
    context,
  }, testInfo) => {    await page.goto(`/projects/${PRIMARY_PROJECT.id}`);
    await click(
      page
        .locator('[data-testid="wallet-connect-button"][data-wallet-id="freighter"]')
        .last(),
      testInfo,
    );
    await expect(page.getByTestId("donation-amount")).toBeVisible();

    await page.getByTestId("donation-amount").fill("25");

    // Go offline and donate — the donation is queued with a dismissible
    // notice; the form returns to idle and stays usable (queued ≠ success).
    await context.setOffline(true);
    await click(page.getByTestId("donate-button"), testInfo);
    await expect(page.getByTestId("cancel-notice")).toBeVisible();
    await expect(page.getByTestId("cancel-notice")).toContainText(/queued/i);
    await expect(page.getByTestId("donate-button")).toBeVisible();

    // The connectivity banner shows the queue badge while offline.
    await expect(page.getByTestId("queued-count-badge")).toContainText(
      "1 donation",
    );

    // Reconnect — the queue drains through the idempotency pre-check and the
    // donation is recorded exactly once (zero duplicates).
    await context.setOffline(false);
    await expect
      .poll(() => backend.donations.length, { timeout: 15000 })
      .toBe(1);

    // Nothing was recorded while offline (no partial writes).
    expect(backend.donations).toHaveLength(1);
  });

  test("two tabs sharing the queue record the offline donation exactly once on reconnect", async ({
    page,
    context,
  }, testInfo) => {
    // Tab B opens the same origin FIRST (while online — it can't navigate
    // offline) and lands on the same project page.
    const tabB = await context.newPage();
    await tabB.addInitScript(() => {
      try {
        window.localStorage.setItem("indigopay-donation-v2", "true");
      } catch {
        // about:blank has no origin — re-set after first load below.
      }
    });
    await mockFreighterWallet(tabB);
    await mockBackendAPI(tabB, backend);
    await mockHorizonAPI(tabB);
    await tabB.goto("/");
    await tabB.evaluate(() =>
      window.localStorage.setItem("indigopay-donation-v2", "true"),
    );
    await tabB.goto(`/projects/${PRIMARY_PROJECT.id}`);
    await expect(
      tabB
        .locator('[data-testid="wallet-connect-button"][data-wallet-id="freighter"]')
        .last(),
    ).toBeVisible();

    // Tab A queues a donation while offline — the queue is shared per-origin,
    // so tab B sees the same IndexedDB queue.
    await page.goto(`/projects/${PRIMARY_PROJECT.id}`);
    await click(
      page
        .locator('[data-testid="wallet-connect-button"][data-wallet-id="freighter"]')
        .last(),
      testInfo,
    );
    await expect(page.getByTestId("donation-amount")).toBeVisible();
    await page.getByTestId("donation-amount").fill("25");
    await context.setOffline(true);
    await click(page.getByTestId("donate-button"), testInfo);
    await expect(page.getByTestId("cancel-notice")).toBeVisible();

    // Tab B's offline badge reflects the shared queue.
    await expect(tabB.getByTestId("queued-count-badge")).toContainText(
      "1 donation",
    );

    // Reconnect — BOTH tabs' drain routines fire, but the atomic cross-tab
    // lease lets only the owner process the queue (the other tab is denied
    // outright), and the server idempotency contract dedupes even in a
    // submission race: exactly one donation record, both tabs' badges clear.
    await context.setOffline(false);
    await expect
      .poll(() => backend.donations.length, { timeout: 15000 })
      .toBe(1);

    await expect(page.getByTestId("queued-count-badge")).toBeHidden({
      timeout: 15000,
    });
    await expect(tabB.getByTestId("queued-count-badge")).toBeHidden({
      timeout: 15000,
    });
    await tabB.close();
  });

  test("reconnect skips a queued donation another tab already recorded (conflict toast)", async ({
    page,
    context,
  }, testInfo) => {
    await page.goto(`/projects/${PRIMARY_PROJECT.id}`);
    await click(
      page
        .locator('[data-testid="wallet-connect-button"][data-wallet-id="freighter"]')
        .last(),
      testInfo,
    );
    await expect(page.getByTestId("donation-amount")).toBeVisible();
    await page.getByTestId("donation-amount").fill("25");

    // Queue the donation while offline.
    await context.setOffline(true);
    await click(page.getByTestId("donate-button"), testInfo);
    await expect(page.getByTestId("cancel-notice")).toContainText(/queued/i);
    await expect(page.getByTestId("queued-count-badge")).toContainText(
      "1 donation",
    );

    // Simulate the OTHER tab: it already recorded this donation (same
    // idempotency key) before connectivity returned.  Read the queued
    // payload straight from the shared IndexedDB queue.
    const queued = await page.evaluate(async () => {
      return new Promise<{
        idempotencyKey: string;
        donorAddress: string;
        amount: string;
      }>((resolve) => {
        const request = indexedDB.open("indigopay-offline-db");
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("donations", "readonly");
          const all = tx.objectStore("donations").getAll();
          all.onsuccess = () => {
            const item = all.result[0]?.payload ?? {};
            db.close();
            resolve({
              idempotencyKey: item.idempotencyKey ?? "",
              donorAddress: item.donorAddress ?? "",
              amount: item.amount ?? "",
            });
          };
        };
      });
    });
    expect(queued.idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    const otherTabDonation: Donation & { idempotencyKey: string } = {
      id: "e2e-conflict-donation",
      projectId: PRIMARY_PROJECT.id,
      donorAddress: queued.donorAddress,
      amount: queued.amount,
      amountXLM: queued.amount,
      currency: "XLM",
      transactionHash: "ab".repeat(32),
      createdAt: new Date().toISOString(),
      idempotencyKey: queued.idempotencyKey,
    };
    backend.donations.push(otherTabDonation);

    // Reconnect — the queued copy is recognised as already-processed by the
    // idempotency pre-check, skipped (never re-submitted), dropped from the
    // queue, and the donor sees the conflict toast.  Exactly one donation
    // record: zero duplicates.
    await context.setOffline(false);
    await expect(
      page.getByText(
        "This donation was already processed while you were offline",
      ),
    ).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("queued-count-badge")).toBeHidden({
      timeout: 15000,
    });
    expect(backend.donations).toHaveLength(1);
  });
});
