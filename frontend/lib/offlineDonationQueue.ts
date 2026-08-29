import { safeRandomUUID } from "../utils/uuid";

export interface DonationQueuePayload {
  projectId: string;
  donorAddress: string;
  amount: string;
  currency: "XLM" | "USDC";
  message?: string;
  encrypted?: boolean;
  transactionHash?: string;
  idempotencyKey?: string;
  sourceAsset?: string;
  conversionPath?: Array<{ code: string; issuer: string }>;
  convertedAmountXLM?: string;
}

export interface QueuedDonation {
  id: string;
  payload: DonationQueuePayload;
  createdAt: string;
  status: "queued";
}

export interface QueueSyncResult {
  /** Donations submitted successfully and removed from the queue. */
  submitted: number;
  /** Donations skipped because the server already recorded their idempotency key. */
  skipped: number;
  /** Donations that failed to submit and remain queued. */
  failed: number;
}

const DB_NAME = "indigopay-offline-db";
const STORE_NAME = "donations";
/** Cross-tab drain lease (see acquireDrainLease below). */
const LEASE_STORE_NAME = "drain-lease";
const DB_VERSION = 2;

/**
 * BroadcastChannel used ONLY to notify other tabs that the shared queue
 * changed (badge refresh).  Cross-tab drain coordination is NOT done over
 * the channel — it uses an atomic IndexedDB lease, so a slow or crashed
 * tab can never block the queue (see acquireDrainLease).
 */
const SYNC_CHANNEL_NAME = "indigopay-queue-sync";

/**
 * Queue-change notification so badges (ConnectivityBanner, OfflineFallback)
 * refresh instantly instead of waiting for their polling interval.
 *
 * Delivered two ways: a window event for the tab that made the change, and a
 * BroadcastChannel message for every other tab (the queue is shared per
 * origin, so a donation queued in one tab must update the badge in all).
 */
const QUEUE_CHANGED_EVENT = "indigopay-queue-changed";
const QUEUE_CHANGED_MESSAGE = "queue-changed";

/** Lazily-created channel used to broadcast queue changes across tabs. */
let notifyChannel: BroadcastChannel | null = null;

function getNotifyChannel(): BroadcastChannel | null {
  if (typeof window === "undefined" || !("BroadcastChannel" in window)) {
    return null;
  }
  if (!notifyChannel) {
    try {
      notifyChannel = new BroadcastChannel(SYNC_CHANNEL_NAME);
    } catch {
      notifyChannel = null;
    }
  }
  return notifyChannel;
}

function notifyQueueChanged(): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent(QUEUE_CHANGED_EVENT));
  } catch {
    // CustomEvent unavailable — badges fall back to their polling interval.
  }
  try {
    getNotifyChannel()?.postMessage(QUEUE_CHANGED_MESSAGE);
  } catch {
    // BroadcastChannel unavailable — same-tab event still fired above.
  }
}

/**
 * Subscribe to queue changes (enqueue/remove), including changes made in
 * OTHER tabs. Returns an unsubscribe function.
 */
export function subscribeQueueChanged(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onWindow = () => listener();
  window.addEventListener(QUEUE_CHANGED_EVENT, onWindow);

  let channel: BroadcastChannel | null = null;
  try {
    if ("BroadcastChannel" in window) {
      channel = new BroadcastChannel(SYNC_CHANNEL_NAME);
      channel.onmessage = (ev) => {
        if (ev.data === QUEUE_CHANGED_MESSAGE) listener();
      };
    }
  } catch {
    channel = null;
  }

  return () => {
    window.removeEventListener(QUEUE_CHANGED_EVENT, onWindow);
    channel?.close();
  };
}

/**
 * Identity of this tab (one per module instance).  Used as the owner of the
 * cross-tab drain lease so a tab only ever releases ITS OWN lease.
 */
let TAB_ID = safeRandomUUID();

/**
 * Test-only: assign the tab identity used for the cross-tab drain lease.
 * Lets a single jsdom instance simulate two tabs sharing the queue (and the
 * lease store).  Harmless in production — it only changes the owner label.
 */
export function setTabIdForTests(tabId: string): void {
  TAB_ID = tabId;
}

/** Per-tab mutex so a single tab never drains the queue twice concurrently. */
const syncingTabs = new Set<string>();

/**
 * Lease record stored in the shared IndexedDB (single readwrite transaction
 * = atomic across tabs).  `expiresAt` is the safety net for a crashed tab:
 * its lease lapses and another tab can take over.
 */
interface DrainLease {
  id: string;
  owner: string;
  expiresAt: number;
}

const LEASE_RECORD_ID = "queue-drain-lease";
/** How long a lease stays valid before another tab may take over. */
const LEASE_TTL_MS = 30_000;

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined" || !("indexedDB" in window)) {
      reject(new Error("IndexedDB is not available"));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(LEASE_STORE_NAME)) {
        db.createObjectStore(LEASE_STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Failed to open IndexedDB"));
  });
}

export async function queueDonation(payload: DonationQueuePayload) {
  if (typeof window === "undefined") return null;

  const record: QueuedDonation = {
    id: safeRandomUUID(),
    payload,
    createdAt: new Date().toISOString(),
    status: "queued",
  };

  const db = await openDatabase();
  const tx = db.transaction(STORE_NAME, "readwrite");
  const store = tx.objectStore(STORE_NAME);
  store.add(record);

  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("Failed to queue donation"));
  });
  db.close();
  notifyQueueChanged();

  // Best-effort background-sync registration. Deliberately NOT awaited: the
  // record is already durable in IndexedDB, and navigator.serviceWorker.ready
  // never resolves when no service worker is registered (fresh installs,
  // private browsing, E2E) — awaiting it would hang the caller and leave the
  // UI stuck on the form instead of showing the queued confirmation.
  void requestBackgroundSync().catch(() => {});
  return record;
}

export async function getQueuedDonations(): Promise<QueuedDonation[]> {
  if (typeof window === "undefined") return [];

  const db = await openDatabase();
  const tx = db.transaction(STORE_NAME, "readonly");
  const store = tx.objectStore(STORE_NAME);
  const result = await new Promise<QueuedDonation[]>((resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result as QueuedDonation[]);
    request.onerror = () => reject(request.error || new Error("Failed to read queued donations"));
  });
  db.close();

  return result;
}

/**
 * Number of donations currently queued for submission — surfaced as a badge
 * in ConnectivityBanner / OfflineFallback (Workstream 2).
 */
export async function getQueuedCount(): Promise<number> {
  const queued = await getQueuedDonations();
  return queued.length;
}

export async function removeQueuedDonation(id: string) {
  if (typeof window === "undefined") return;

  const db = await openDatabase();
  const tx = db.transaction(STORE_NAME, "readwrite");
  tx.objectStore(STORE_NAME).delete(id);

  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("Failed to remove queued donation"));
  });
  db.close();
  notifyQueueChanged();
}

/**
 * Atomically claim the cross-tab drain lease.
 *
 * The check-and-set runs inside ONE readwrite transaction on the shared
 * IndexedDB lease store, and readwrite transactions on the same store are
 * exclusive — so two tabs can never both acquire it (no compare-and-swap
 * race).  Only the lease owner drains the queue; BroadcastChannel is used
 * solely to NOTIFY other tabs of queue changes, never to coordinate.
 *
 * A lease expires after LEASE_TTL_MS, so a tab that crashed mid-drain (and
 * could not release) never blocks the queue forever — the next sync takes
 * over.  When IndexedDB is unavailable the lease is skipped entirely and
 * the caller degrades to the per-tab mutex only.
 *
 * @returns True when this tab owns the lease and may drain.
 */
async function acquireDrainLease(): Promise<boolean> {
  if (typeof window === "undefined" || !("indexedDB" in window)) return true;
  const db = await openDatabase();
  try {
    const tx = db.transaction(LEASE_STORE_NAME, "readwrite");
    const store = tx.objectStore(LEASE_STORE_NAME);
    const now = Date.now();

    const existing = await new Promise<DrainLease | undefined>(
      (resolve, reject) => {
        const request = store.get(LEASE_RECORD_ID);
        request.onsuccess = () =>
          resolve(request.result as DrainLease | undefined);
        request.onerror = () =>
          reject(request.error || new Error("Failed to read drain lease"));
      },
    );

    // Another tab owns a live lease — not ours.
    if (existing && existing.expiresAt > now) return false;

    store.put({ id: LEASE_RECORD_ID, owner: TAB_ID, expiresAt: now + LEASE_TTL_MS });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () =>
        reject(tx.error || new Error("Failed to acquire drain lease"));
    });
    return true;
  } finally {
    db.close();
  }
}

/**
 * Release the drain lease — only if THIS tab still owns it, so a lease that
 * expired (crashed-owner takeover) is never deleted out from under the new
 * owner.  Best-effort: failures are swallowed (the TTL still expires it).
 */
async function releaseDrainLease(): Promise<void> {
  if (typeof window === "undefined" || !("indexedDB" in window)) return;
  try {
    const db = await openDatabase();
    try {
      const tx = db.transaction(LEASE_STORE_NAME, "readwrite");
      const store = tx.objectStore(LEASE_STORE_NAME);
      const existing = await new Promise<DrainLease | undefined>(
        (resolve, reject) => {
          const request = store.get(LEASE_RECORD_ID);
          request.onsuccess = () =>
            resolve(request.result as DrainLease | undefined);
          request.onerror = () =>
            reject(request.error || new Error("Failed to read drain lease"));
        },
      );
      if (existing && existing.owner === TAB_ID) {
        store.delete(LEASE_RECORD_ID);
      }
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () =>
          reject(tx.error || new Error("Failed to release drain lease"));
      });
    } finally {
      db.close();
    }
  } catch {
    // Lease release is best-effort — the TTL expires it if this fails.
  }
}

/**
 * Drain the queued donations.
 *
 * Conflict resolution (Workstream 2): before submitting an item, when it
 * carries an idempotencyKey the caller may pass `checkAlreadyProcessed` to
 * ask the server whether that key was already recorded (e.g. by another tab
 * or a background-sync attempt).  If it was, the queued copy is dropped
 * without submitting — guaranteeing zero duplicate donation records.
 *
 * Cross-tab coordination: an atomic IndexedDB lease is acquired BEFORE
 * getQueuedDonations; only the lease owner processes the queue, and the
 * lease is released (or expires via TTL after a crash) when draining ends.
 * BroadcastChannel is used solely to notify other tabs of queue changes.
 * A per-tab mutex additionally prevents concurrent drains in the same tab.
 *
 * @param processor - Submits one donation; return true to remove from queue.
 * @param opts.checkAlreadyProcessed - Optional idempotency pre-check.
 * @returns Per-category counts so the UI can show sync progress.
 */
export async function syncQueuedDonations(
  processor: (payload: DonationQueuePayload) => Promise<boolean>,
  opts: {
    checkAlreadyProcessed?: (
      payload: DonationQueuePayload,
    ) => Promise<boolean>;
  } = {},
): Promise<QueueSyncResult> {
  const result: QueueSyncResult = { submitted: 0, skipped: 0, failed: 0 };

  // Per-tab mutex: never drain twice concurrently in the same tab.
  if (syncingTabs.has(TAB_ID)) return result;
  syncingTabs.add(TAB_ID);

  try {
    // Cross-tab lease: only the owner may process the queue.  A live lease
    // held by another tab makes us return without touching a single item.
    let acquired = false;
    try {
      acquired = await acquireDrainLease();
    } catch {
      // Lease store unavailable (e.g. IndexedDB degraded) — proceed on the
      // per-tab mutex alone rather than dropping the drain entirely.
      acquired = true;
    }
    if (!acquired) return result;

    try {
      const queued = await getQueuedDonations();
      for (const item of queued) {
        // Conflict resolution: skip donations the server already recorded.
        if (opts.checkAlreadyProcessed && item.payload.idempotencyKey) {
          try {
            const alreadyProcessed = await opts.checkAlreadyProcessed(
              item.payload,
            );
            if (alreadyProcessed) {
              await removeQueuedDonation(item.id);
              result.skipped += 1;
              continue;
            }
          } catch {
            // Pre-check failed (server unreachable) — fall through to the
            // processor, which is expected to fail too and keep the item.
          }
        }

        try {
          const completed = await processor(item.payload);
          if (completed) {
            await removeQueuedDonation(item.id);
            result.submitted += 1;
          } else {
            result.failed += 1;
          }
        } catch {
          // A throwing processor must never abort the drain — the remaining
          // queued donations still need to be attempted.  Count this one as
          // failed and keep going (zero lost donations).
          result.failed += 1;
        }
      }
    } finally {
      // Release the cross-tab lease (best-effort — the TTL expires it if
      // this throws) so the next tab can take over immediately.
      await releaseDrainLease();
    }
  } finally {
    syncingTabs.delete(TAB_ID);
  }

  return result;
}

export async function requestBackgroundSync() {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;

  try {
    // navigator.serviceWorker.ready can wait indefinitely when no service
    // worker is registered — bound it so callers can never hang on it.
    const registration = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Service worker not ready")), 2000),
      ),
    ]);
    const syncManager = (registration as ServiceWorkerRegistration & {
      sync?: { register: (tag: string) => Promise<void> };
    }).sync;
    if (syncManager) {
      await syncManager.register("donation-queue");
    }
  } catch {
    // Ignore unsupported environments and the readiness timeout — the queue
    // is durable in IndexedDB and drains on reconnect / next page load.
  }
}
