import { safeRandomUUID } from "../utils/uuid";

export interface DonationQueuePayload {
  projectId: string;
  donorAddress: string;
  amount: string;
  currency: "XLM" | "USDC";
  message?: string;
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
const DB_VERSION = 1;

/** BroadcastChannel used to coordinate queue draining across browser tabs. */
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

/** Per-tab mutex so a single tab never drains the queue twice concurrently. */
let syncingInThisTab = false;

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

function openSyncChannel(): BroadcastChannel | null {
  if (typeof window === "undefined" || !("BroadcastChannel" in window)) return null;
  try {
    return new BroadcastChannel(SYNC_CHANNEL_NAME);
  } catch {
    return null;
  }
}

/**
 * Wait until any sync started by another tab finishes, so two tabs never
 * drain the queue simultaneously (Workstream 2).  If no other tab is
 * syncing, resolves immediately; capped at 1s so a crashed tab can never
 * block the queue forever.
 */
function waitForOtherTabSync(channel: BroadcastChannel | null): Promise<void> {
  if (!channel) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      channel.onmessage = null;
      resolve();
    };
    const timer = setTimeout(finish, 1000);
    channel.onmessage = (ev) => {
      if (ev.data === "sync-end") finish();
    };
  });
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
 * BroadcastChannel coordination: tabs announce sync-start/sync-end; a tab
 * that sees another tab syncing defers by up to 1s, and a per-tab mutex
 * prevents concurrent drains within the same tab.
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
  if (syncingInThisTab) return result;
  syncingInThisTab = true;

  const channel = openSyncChannel();
  try {
    await waitForOtherTabSync(channel);
    if (channel) channel.postMessage("sync-start");

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
    syncingInThisTab = false;
    if (channel) {
      channel.postMessage("sync-end");
      channel.close();
    }
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
