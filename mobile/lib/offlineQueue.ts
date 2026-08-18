/**
 * lib/offlineQueue.ts
 *
 * Offline-first FIFO queue for operations that must be submitted when
 * connectivity is restored.
 *
 * Key differences from `utils/donationQueue.ts`:
 *   - Generic type parameter so it can queue operations OTHER than
 *     donations (e.g. profile edits, project follows).
 *   - Uses proper UUIDs via `crypto.randomUUID()` (or fallback).
 *   - Configurable max retries (default 3).
 *   - Built-in staleness / TTL for old queue items.
 *   - Async event emitter pattern (register onComplete / onFail).
 *
 * The queue persists to AsyncStorage under `offline_queue` key.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

// ─── Constants ──────────────────────────────────────────────────────────

const STORAGE_KEY = "offline_queue";
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_ITEM_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_QUEUE_SIZE = 200;

// ─── UUID Generation ────────────────────────────────────────────────────

function generateUUID(): string {
  // Prefer crypto.randomUUID() (available in Hermes 0.12+ / JSI).
  try {
    return crypto.randomUUID();
  } catch {
    // Fallback for older JS engines
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }
}

// ─── Types ──────────────────────────────────────────────────────────────

export type QueueItemStatus = "pending" | "retrying" | "completed" | "failed";

export interface QueueItem<T = Record<string, unknown>> {
  /** Unique ID (UUID v4). */
  id: string;
  /** Discriminator so the worker knows which handler to call. */
  type: string;
  /** The operation payload. */
  payload: T;
  /** Current status. */
  status: QueueItemStatus;
  /** Number of attempts so far. */
  attempts: number;
  /** Maximum attempts before giving up. */
  maxAttempts: number;
  /** Timestamp (ms) for the next retry. */
  nextRetryAt: number;
  /** When the item was first queued. */
  queuedAt: number;
  /** When the item was last updated. */
  updatedAt: number;
  /** Last error message, if any. */
  lastError?: string;
  /** Result data on completion (e.g. transaction hash). */
  result?: T;
}

export interface QueueSummary {
  total: number;
  pending: number;
  retrying: number;
  completed: number;
  failed: number;
}

export interface EnqueueParams<T = Record<string, unknown>> {
  type: string;
  payload: T;
  maxRetries?: number;
}

// ─── Callbacks ──────────────────────────────────────────────────────────

export type QueueEventCallback<T = Record<string, unknown>> = (
  item: QueueItem<T>,
) => void;

let onItemComplete: QueueEventCallback | null = null;
let onItemFail: QueueEventCallback | null = null;

/**
 * Register a callback fired when any queue item reaches "completed" status.
 */
export function onQueueItemComplete(cb: QueueEventCallback): void {
  onItemComplete = cb;
}

/**
 * Register a callback fired when any queue item reaches "failed" status
 * (after exhausting all retries).
 */
export function onQueueItemFail(cb: QueueEventCallback): void {
  onItemFail = cb;
}

// ─── Internal helpers ──────────────────────────────────────────────────

async function readQueue<T = Record<string, unknown>>(): Promise<
  QueueItem<T>[]
> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

async function writeQueue<T>(
  queue: QueueItem<T>[],
): Promise<void> {
  // Cap queue size to prevent storage abuse
  if (queue.length > MAX_QUEUE_SIZE) {
    queue = queue.slice(queue.length - MAX_QUEUE_SIZE);
  }
  // Prune expired items
  const cutoff = Date.now() - DEFAULT_ITEM_TTL_MS;
  queue = queue.filter(
    (item) =>
      item.status === "pending" ||
      item.status === "retrying" ||
      item.updatedAt > cutoff,
  );
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
}

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Enqueue a new offline operation.
 *
 * @returns The newly created QueueItem.
 */
export async function enqueueItem<T = Record<string, unknown>>(
  params: EnqueueParams<T>,
): Promise<QueueItem<T>> {
  const now = Date.now();
  const maxAttempts = params.maxRetries ?? DEFAULT_MAX_RETRIES;
  const item: QueueItem<T> = {
    id: generateUUID(),
    type: params.type,
    payload: params.payload,
    status: "pending",
    attempts: 0,
    maxAttempts,
    nextRetryAt: now, // eligible for immediate retry
    queuedAt: now,
    updatedAt: now,
  };

  const queue = await readQueue<T>();
  queue.push(item);
  await writeQueue(queue);

  return item;
}

/**
 * Read all queued items, sorted oldest-first (FIFO).
 */
export async function getQueue<T = Record<string, unknown>>(): Promise<
  QueueItem<T>[]
> {
  const queue = await readQueue<T>();
  return queue.sort((a, b) => a.queuedAt - b.queuedAt);
}

/**
 * Get only items that are eligible for retry (pending/retrying, not expired,
 * nextRetryAt ≤ now).
 */
export async function getRetryEligible<T = Record<string, unknown>>(): Promise<
  QueueItem<T>[]
> {
  const queue = await readQueue<T>();
  const now = Date.now();
  return queue.filter(
    (item) =>
      (item.status === "pending" || item.status === "retrying") &&
      item.attempts < item.maxAttempts &&
      item.nextRetryAt <= now,
  );
}

/**
 * Get items filtered by type (e.g. "donation", "profile_edit").
 */
export async function getItemsByType<T = Record<string, unknown>>(
  type: string,
): Promise<QueueItem<T>[]> {
  const queue = await readQueue<T>();
  return queue.filter((item) => item.type === type) as QueueItem<T>[];
}

/**
 * Count items that are still pending or retrying.
 */
export async function getPendingCount(): Promise<number> {
  const queue = await readQueue();
  return queue.filter(
    (item) => item.status === "pending" || item.status === "retrying",
  ).length;
}

/**
 * Get queue summary for status display.
 */
export async function getQueueSummary(): Promise<QueueSummary> {
  const queue = await readQueue();
  return {
    total: queue.length,
    pending: queue.filter((i) => i.status === "pending").length,
    retrying: queue.filter((i) => i.status === "retrying").length,
    completed: queue.filter((i) => i.status === "completed").length,
    failed: queue.filter((i) => i.status === "failed").length,
  };
}

/**
 * Mark an item as "retrying" (in-flight).
 */
export async function markRetrying(id: string): Promise<void> {
  const queue = await readQueue();
  const item = queue.find((i) => i.id === id);
  if (!item) return;
  item.status = "retrying";
  item.updatedAt = Date.now();
  await writeQueue(queue);
}

/**
 * Mark an item as successfully completed.
 */
export async function markCompleted<T = Record<string, unknown>>(
  id: string,
  result?: T,
): Promise<void> {
  const queue = await readQueue();
  const item = queue.find((i) => i.id === id);
  if (!item) return;
  item.status = "completed";
  if (result) item.result = result as any;
  item.updatedAt = Date.now();
  await writeQueue(queue);

  if (onItemComplete) {
    try {
      onItemComplete(item);
    } catch {
      // Swallow callback errors
    }
  }
}

/**
 * Record a failed attempt and schedule the next retry.
 */
export async function markFailed(
  id: string,
  errorMessage: string,
): Promise<void> {
  const queue = await readQueue();
  const item = queue.find((i) => i.id === id);
  if (!item) return;

  item.attempts += 1;
  item.lastError = errorMessage;
  item.updatedAt = Date.now();

  // Exponential backoff: 30s, 2m, 10m
  const BACKOFF_MS = [30_000, 120_000, 600_000];
  const backoffIndex = Math.min(item.attempts - 1, BACKOFF_MS.length - 1);

  if (item.attempts >= item.maxAttempts) {
    item.status = "failed";
    item.nextRetryAt = 0;

    if (onItemFail) {
      try {
        onItemFail(item);
      } catch {
        // Swallow callback errors
      }
    }
  } else {
    item.status = "pending";
    item.nextRetryAt = Date.now() + BACKOFF_MS[backoffIndex];
  }

  await writeQueue(queue);
}

/**
 * Remove a single item from the queue.
 */
export async function removeItem(id: string): Promise<void> {
  const queue = await readQueue();
  const filtered = queue.filter((i) => i.id !== id);
  await writeQueue(filtered);
}

/**
 * Remove all completed and failed items (garbage collection).
 */
export async function cleanQueue(): Promise<void> {
  const queue = await readQueue();
  const active = queue.filter(
    (i) => i.status === "pending" || i.status === "retrying",
  );
  await writeQueue(active);
}

/**
 * Remove ALL items from the queue.
 */
export async function clearQueue(): Promise<void> {
  await AsyncStorage.removeItem(STORAGE_KEY);
}
