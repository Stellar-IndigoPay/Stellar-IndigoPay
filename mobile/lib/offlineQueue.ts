/**
 * lib/offlineQueue.ts
 *
 * Offline-first FIFO queue for operations that must be submitted when
 * connectivity is restored.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

// ─── Constants ──────────────────────────────────────────────────────────

const STORAGE_KEY = 'offline_queue_v2';
const LEGACY_STORAGE_KEY = 'offline_queue';
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_ITEM_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_QUEUE_SIZE = 200;

// ─── UUID Generation ────────────────────────────────────────────────────

function generateUUID(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }
}

// ─── Types ──────────────────────────────────────────────────────────────

export type QueueItemStatus = 'pending' | 'in_flight' | 'completed' | 'failed';

export interface QueueItem<T = Record<string, unknown>> {
  id: string;
  type: string;
  payload: T;
  status: QueueItemStatus;
  attempts: number;
  maxAttempts: number;
  nextRetryAt: number;
  queuedAt: number;
  updatedAt: number;
  lastError?: string;
  result?: T;
  idempotencyKey?: string;
}

export interface QueueSummary {
  total: number;
  pending: number;
  in_flight: number;
  completed: number;
  failed: number;
}

export interface EnqueueParams<T = Record<string, unknown>> {
  type: string;
  payload: T;
  maxRetries?: number;
  idempotencyKey?: string;
}

// ─── Callbacks ──────────────────────────────────────────────────────────

export type QueueEventCallback<T = Record<string, unknown>> = (
  item: QueueItem<T>,
) => void;

let onItemComplete: QueueEventCallback | null = null;
let onItemFail: QueueEventCallback | null = null;
let onQueueCorruption: ((err: any) => void) | null = null;

export function onQueueItemComplete(cb: QueueEventCallback): void {
  onItemComplete = cb;
}

export function onQueueItemFail(cb: QueueEventCallback): void {
  onItemFail = cb;
}

export function setOnQueueCorruption(cb: (err: any) => void): void {
  onQueueCorruption = cb;
}

// ─── Atomic File Mutex ──────────────────────────────────────────────────

let queueMutex = Promise.resolve();

async function withQueue<T, R>(action: (queue: QueueItem<T>[]) => Promise<R> | R): Promise<R> {
  return new Promise<R>((resolve, reject) => {
    queueMutex = queueMutex.then(async () => {
      try {
        const queue = await readQueue<T>();
        const result = await action(queue);
        resolve(result);
      } catch (err) {
        reject(err);
      }
    });
  });
}

// ─── Internal helpers ──────────────────────────────────────────────────

async function readQueue<T = Record<string, unknown>>(): Promise<QueueItem<T>[]> {
  try {
    let raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) {
      const legacy = await AsyncStorage.getItem(LEGACY_STORAGE_KEY);
      if (legacy) {
        const legacyItems = JSON.parse(legacy);
        const migrated = legacyItems.map((item: any) => ({
          ...item,
          status: item.status === 'retrying' ? 'in_flight' : item.status,
          idempotencyKey: item.idempotencyKey || item.id,
        }));
        await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
        await AsyncStorage.removeItem(LEGACY_STORAGE_KEY);
        return migrated;
      }
      return [];
    }
    return JSON.parse(raw);
  } catch (err) {
    try {
      const badRaw = await AsyncStorage.getItem(STORAGE_KEY);
      if (badRaw) {
        await AsyncStorage.setItem(STORAGE_KEY + '_quarantined', badRaw);
        await AsyncStorage.removeItem(STORAGE_KEY);
      }
    } catch {
      // Ignore inner errors
    }
    if (onQueueCorruption) onQueueCorruption(err);
    console.warn('[OfflineQueue] Queue corruption detected and quarantined.');
    return [];
  }
}

async function writeQueue<T>(queue: QueueItem<T>[]): Promise<void> {
  if (queue.length > MAX_QUEUE_SIZE) {
    queue = queue.slice(queue.length - MAX_QUEUE_SIZE);
  }
  const cutoff = Date.now() - DEFAULT_ITEM_TTL_MS;
  queue = queue.filter(
    (item) =>
      item.status === 'pending' ||
      item.status === 'in_flight' ||
      item.updatedAt > cutoff,
  );
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
}

// ─── Public API ─────────────────────────────────────────────────────────

export async function recoverInFlightItems(): Promise<void> {
  await withQueue(async (queue) => {
    let changed = false;
    for (const item of queue) {
      if (item.status === 'in_flight') {
        item.status = 'pending';
        changed = true;
      }
    }
    if (changed) {
      await writeQueue(queue);
    }
  });
}

export async function enqueueItem<T = Record<string, unknown>>(
  params: EnqueueParams<T>,
): Promise<QueueItem<T>> {
  return withQueue(async (queue) => {
    const now = Date.now();
    const maxAttempts = params.maxRetries ?? DEFAULT_MAX_RETRIES;
    const item: QueueItem<T> = {
      id: generateUUID(),
      type: params.type,
      payload: params.payload,
      status: 'pending',
      attempts: 0,
      maxAttempts,
      nextRetryAt: now,
      queuedAt: now,
      updatedAt: now,
      idempotencyKey: params.idempotencyKey || generateUUID(),
    };
    queue.push(item);
    await writeQueue(queue);
    return item;
  });
}

export async function getQueue<T = Record<string, unknown>>(): Promise<QueueItem<T>[]> {
  return withQueue((queue: any[]) => queue.sort((a, b) => a.queuedAt - b.queuedAt));
}

export async function getRetryEligible<T = Record<string, unknown>>(): Promise<QueueItem<T>[]> {
  const now = Date.now();
  return withQueue((queue: any[]) => queue.filter(
    (item) =>
      (item.status === 'pending' || item.status === 'in_flight') &&
      item.attempts < item.maxAttempts &&
      item.nextRetryAt <= now,
  ));
}

export async function getItemsByType<T = Record<string, unknown>>(
  type: string,
): Promise<QueueItem<T>[]> {
  return withQueue((queue: any[]) => queue.filter((item) => item.type === type));
}

export async function getPendingCount(): Promise<number> {
  return withQueue((queue) => queue.filter(
    (item) => item.status === 'pending' || item.status === 'in_flight',
  ).length);
}

export async function getQueueSummary(): Promise<QueueSummary> {
  return withQueue((queue) => ({
    total: queue.length,
    pending: queue.filter((i) => i.status === 'pending').length,
    in_flight: queue.filter((i) => i.status === 'in_flight').length,
    completed: queue.filter((i) => i.status === 'completed').length,
    failed: queue.filter((i) => i.status === 'failed').length,
  }));
}

export async function markInFlight(id: string): Promise<void> {
  await withQueue(async (queue) => {
    const item = queue.find((i) => i.id === id);
    if (!item) return;
    item.status = 'in_flight';
    item.updatedAt = Date.now();
    await writeQueue(queue);
  });
}

export const markRetrying = markInFlight;

export async function preSubmitCheck(
  id: string,
  checker: (key: string) => Promise<boolean>
): Promise<boolean> {
  let keyToCheck: string | undefined;
  await withQueue((queue) => {
    const item = queue.find((i) => i.id === id);
    if (item && item.idempotencyKey) {
      keyToCheck = item.idempotencyKey;
    }
  });
  
  if (!keyToCheck) return false;
  
  const isCompletedOnServer = await checker(keyToCheck);
  
  if (isCompletedOnServer) {
    let matchedItem: any = null;
    await withQueue(async (queue) => {
      const item = queue.find((i) => i.id === id);
      if (item) {
        item.status = 'completed';
        item.updatedAt = Date.now();
        await writeQueue(queue);
        matchedItem = item;
      }
    });
    if (matchedItem && onItemComplete) {
      try { onItemComplete(matchedItem); } catch {}
    }
    return true;
  }
  return false;
}

export async function markCompleted<T = Record<string, unknown>>(
  id: string,
  result?: T,
): Promise<void> {
  let matchedItem: any = null;
  await withQueue(async (queue) => {
    const item = queue.find((i) => i.id === id);
    if (!item) return;
    item.status = 'completed';
    if (result) item.result = result as any;
    item.updatedAt = Date.now();
    await writeQueue(queue);
    matchedItem = item;
  });
  if (matchedItem && onItemComplete) {
    try { onItemComplete(matchedItem); } catch {}
  }
}

export async function markFailed(
  id: string,
  errorMessage: string,
): Promise<void> {
  let failedItem: any = null;
  await withQueue(async (queue) => {
    const item = queue.find((i) => i.id === id);
    if (!item) return;
    item.attempts += 1;
    item.lastError = errorMessage;
    item.updatedAt = Date.now();
    const BACKOFF_MS = [30_000, 120_000, 600_000];
    const backoffIndex = Math.min(item.attempts - 1, BACKOFF_MS.length - 1);
    if (item.attempts >= item.maxAttempts) {
      item.status = 'failed';
      item.nextRetryAt = 0;
      failedItem = item;
    } else {
      item.status = 'pending';
      item.nextRetryAt = Date.now() + BACKOFF_MS[backoffIndex];
    }
    await writeQueue(queue);
  });
  if (failedItem && onItemFail) {
    try { onItemFail(failedItem); } catch {}
  }
}

export async function removeItem(id: string): Promise<void> {
  await withQueue(async (queue) => {
    const filtered = queue.filter((i) => i.id !== id);
    await writeQueue(filtered);
  });
}

export async function cleanQueue(): Promise<void> {
  await withQueue(async (queue) => {
    const active = queue.filter(
      (i) => i.status === 'pending' || i.status === 'in_flight',
    );
    await writeQueue(active);
  });
}

export async function clearQueue(): Promise<void> {
  await withQueue(async () => {
    await AsyncStorage.removeItem(STORAGE_KEY);
  });
}
