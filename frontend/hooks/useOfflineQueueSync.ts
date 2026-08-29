/**
 * hooks/useOfflineQueueSync.ts
 *
 * Issue #1129 (combined #1024 + #1061) — the single place that drains the
 * IndexedDB-backed offline donation queue and reports the outcome.
 *
 * Drained on three triggers, all funneled into the same routine so a
 * background-sync wake-up, a reconnect, and a page load behave identically:
 *  1. mount (a fresh page load with items left over from a previous session)
 *  2. the window "online" event (connectivity returns)
 *  3. the service worker's "indigopay-queue-sync" nudge (public/sw.js
 *     Background Sync handler — posted when the browser retries the
 *     "donation-queue" sync tag)
 *
 * Each drain:
 *  - runs ONLY while the browser reports online,
 *  - submits through recordDonation with the donation's idempotency key so
 *    the server can dedupe a race,
 *  - pre-checks GET /api/donations/check-idempotency/:key and DROPS queued
 *    items that another tab / a background-sync attempt already recorded
 *    (zero duplicate donation records),
 *  - surfaces the outcome: a toast when a queued donation was skipped as
 *    already-processed, and a browser notification when one was submitted.
 *
 * The cross-tab drain lease lives in the queue module, so multiple tabs (and
 * this hook plus any page-level drain) can never process the same item twice.
 */
import { useCallback, useEffect } from "react";
import { toast } from "sonner";
import { recordDonation, checkIdempotency } from "@/lib/api";
import { syncQueuedDonations } from "@/lib/offlineDonationQueue";
import useOnlineStatus from "@/hooks/useOnlineStatus";

/** Message posted by public/sw.js's Background Sync handler. */
const SW_SYNC_MESSAGE = "indigopay-queue-sync";

/**
 * Best-effort confirmation notification (Part A: "Show push notification when
 * a queued donation is confirmed on-chain").  Only fires when the user has
 * already granted Notification permission — the queue never prompts, so a
 * mid-donation permission dialog can never steal focus from the donor.
 */
async function notifyDonationSubmitted(count: number): Promise<void> {
  if (typeof window === "undefined" || !("Notification" in window)) return;
  if (Notification.permission !== "granted") return;

  const body =
    count === 1
      ? "Your offline donation was submitted successfully."
      : `${count} offline donations were submitted successfully.`;

  try {
    const registration =
      typeof navigator !== "undefined" && navigator.serviceWorker
        ? await navigator.serviceWorker.getRegistration()
        : undefined;
    if (registration && "showNotification" in registration) {
      await registration.showNotification("Donation confirmed", {
        body,
        icon: "/icon-192.png",
        badge: "/icon-192.png",
      });
    } else {
      new Notification("Donation confirmed", { body });
    }
  } catch {
    // Notifications are best-effort — the queue badge already confirms it.
  }
}

export default function useOfflineQueueSync(): void {
  const isOnline = useOnlineStatus();

  const drain = useCallback(() => {
    // Never drain while the browser reports offline — recordDonation and the
    // idempotency pre-check would fail anyway, and the cross-tab lease would
    // be held for nothing.  Live navigator.onLine check (not the closure's
    // isOnline) so the listener registered on the "online" event can never
    // be a stale, offline-holding copy when connectivity just returned.
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;

    void syncQueuedDonations(
      async (payload) => {
        try {
          const { idempotencyKey } = payload;
          if (!idempotencyKey) return false;
          await recordDonation({
            ...payload,
            transactionHash: payload.transactionHash || "queued-offline",
            idempotencyKey,
          });
          return true;
        } catch {
          return false;
        }
      },
      {
        // Conflict resolution (Part B): never re-submit a donation that
        // another tab or a background-sync attempt already recorded — the
        // server dedupes by idempotency key, so check before submitting and
        // drop the queued copy instead.
        checkAlreadyProcessed: async (payload) =>
          payload.idempotencyKey
            ? checkIdempotency(payload.idempotencyKey).catch(() => false)
            : false,
      },
    )
      .then((result) => {
        if (result.skipped > 0) {
          toast("This donation was already processed while you were offline");
        }
        if (result.submitted > 0) {
          void notifyDonationSubmitted(result.submitted);
        }
      })
      .catch(() => {
        // Queue unavailable (no IndexedDB) — retry on the next reconnect.
      });
    // drain is stable ([] deps): the same function is registered on the
    // "online" event, so the event always invokes the live-checked routine
    // above — never a stale closure.
  }, []);

  // Drain once on mount (leftover items from a previous session) and every
  // time connectivity returns.  `isOnline` is deliberately in the deps even
  // though drain is stable: when the browser flips back online, this effect
  // re-runs and immediately drains, covering any event that was missed.
  useEffect(() => {
    if (isOnline) drain();
    window.addEventListener("online", drain);
    return () => window.removeEventListener("online", drain);
  }, [isOnline, drain]);

  // Drain when the service worker wakes us with a Background Sync nudge
  // (public/sw.js posts the plain string "indigopay-queue-sync").
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
      return;
    }
    const onMessage = (event: MessageEvent) => {
      if (event.data === SW_SYNC_MESSAGE) drain();
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    // Optional chaining on cleanup: by the time the effect tears down (page
    // unload / test teardown) navigator.serviceWorker may already be gone.
    return () =>
      navigator.serviceWorker?.removeEventListener("message", onMessage);
  }, [drain]);
}
