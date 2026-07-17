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

const DB_NAME = "indigopay-offline-db";
const STORE_NAME = "donations";
const DB_VERSION = 1;

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
    id: crypto.randomUUID(),
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

  await requestBackgroundSync();
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

  return result;
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
}

export async function syncQueuedDonations(
  processor: (payload: DonationQueuePayload) => Promise<boolean>,
) {
  const queued = await getQueuedDonations();
  for (const item of queued) {
    const completed = await processor(item.payload);
    if (completed) {
      await removeQueuedDonation(item.id);
    }
  }
}

export async function requestBackgroundSync() {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;

  try {
    const registration = await navigator.serviceWorker.ready;
    const syncManager = (registration as ServiceWorkerRegistration & {
      sync?: { register: (tag: string) => Promise<void> };
    }).sync;
    if (syncManager) {
      await syncManager.register("donation-queue");
    }
  } catch {
    // Ignore unsupported environments.
  }
}
