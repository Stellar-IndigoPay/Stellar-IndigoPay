/**
 * utils/donationQueue.ts
 *
 * Offline-first donation queue backed by AsyncStorage.
 *
 * When a donation cannot be submitted due to network failure, it is
 * persisted locally in a FIFO queue. A background retry worker
 * (donationQueueWorker.ts) attempts to submit queued donations with
 * exponential backoff when connectivity is restored.
 *
 * Data model:
 *   QueuedDonation — a single pending donation with retry state
 *   RETRY_BACKOFF_MS — exponential backoff schedule (6 attempts)
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

const STORAGE_KEY = "donation_queue";
const MAX_QUEUE_SIZE = 100;

/**
 * Exponential backoff schedule in milliseconds.
 * Attempt 0→1:  30s
 * Attempt 1→2:  2m
 * Attempt 2→3:  10m
 * Attempt 3→4:  30m
 * Attempt 4→5:  2h
 * Attempt 5→6:  6h (max)
 */
export const RETRY_BACKOFF_MS = [
  30_000,
  120_000,
  600_000,
  1_800_000,
  7_200_000,
  21_600_000,
];

export const MAX_RETRY_ATTEMPTS = RETRY_BACKOFF_MS.length; // 6

export type DonationStatus = "pending" | "retrying" | "submitted" | "failed";

export interface QueuedDonation {
  id: string;
  projectId: string;
  projectName: string;
  amount: string;
  currency: "XLM" | "USDC";
  message?: string;
  donorAddress: string;
  transactionHash?: string;
  status: DonationStatus;
  attempts: number;
  maxAttempts: number;
  nextRetryAt: number;
  lastError?: string;
  /**
   * Machine-readable backend error code captured on the last failure
   * (e.g. "PROJECT_NOT_FOUND", "TX_FAILED"). Used to classify a failure as
   * retryable vs. permanent without re-parsing the human message.
   */
  errorCode?: string;
  /**
   * Whether the last failure is expected to succeed on a later attempt.
   * Permanent (non-retryable) failures stop being picked up by
   * getRetryEligibleDonations() even if attempts < maxAttempts, so a
   * permanently-failed donation never blocks the rest of the queue.
   */
  retryable?: boolean;
  createdAt: number;
  updatedAt: number;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function generateId(): string {
  return `dq_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

async function readQueue(): Promise<QueuedDonation[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

// In-process subscribers notified after the queue is mutated. Used by the UI
// (and the worker) to react to per-item status changes without polling.
type QueueUpdateListener = (queue: QueuedDonation[]) => void;
const updateListeners = new Set<QueueUpdateListener>();

async function writeQueue(queue: QueuedDonation[]): Promise<void> {
  // Cap queue size so a runaway failure mode can't fill storage
  if (queue.length > MAX_QUEUE_SIZE) {
    queue = queue.slice(queue.length - MAX_QUEUE_SIZE);
  }
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
  // Notify listeners with the (possibly trimmed) queue snapshot.
  for (const listener of updateListeners) {
    try {
      listener(queue);
    } catch {
      // a misbehaving listener must not break persistence
    }
  }
}

/**
 * Subscribe to queue mutations. The callback fires with the full queue
 * snapshot after every write. Returns an unsubscribe function.
 *
 * @param listener - called with the latest queue after each change
 * @returns unsubscribe function
 */
export function onQueueItemUpdate(listener: QueueUpdateListener): () => void {
  updateListeners.add(listener);
  return () => {
    updateListeners.delete(listener);
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Enqueue a new donation for offline submission.
 * The donation is persisted to AsyncStorage with initial status "pending".
 *
 * @returns The newly created QueuedDonation.
 */
export async function enqueueDonation(params: {
  projectId: string;
  projectName: string;
  amount: string;
  currency: "XLM" | "USDC";
  message?: string;
  donorAddress: string;
}): Promise<QueuedDonation> {
  const now = Date.now();
  const donation: QueuedDonation = {
    id: generateId(),
    projectId: params.projectId,
    projectName: params.projectName,
    amount: params.amount,
    currency: params.currency,
    message: params.message,
    donorAddress: params.donorAddress,
    status: "pending",
    attempts: 0,
    maxAttempts: MAX_RETRY_ATTEMPTS,
    nextRetryAt: now, // eligible for immediate retry
    retryable: true, // optimistic; downgraded on a permanent failure
    createdAt: now,
    updatedAt: now,
  };

  const queue = await readQueue();
  queue.push(donation);
  await writeQueue(queue);

  return donation;
}

/**
 * Read all queued donations, sorted by createdAt (oldest first = FIFO).
 */
export async function getQueuedDonations(): Promise<QueuedDonation[]> {
  const queue = await readQueue();
  return queue.sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Count donations that are still pending or currently retrying.
 */
export async function getPendingCount(): Promise<number> {
  const queue = await readQueue();
  return queue.filter(
    (d) => d.status === "pending" || d.status === "retrying",
  ).length;
}

/**
 * Get the subset of donations whose nextRetryAt ≤ Date.now() and that are
 * still eligible for retry (attempts < maxAttempts). Permanently-failed
 * donations (retryable === false) are excluded so a single dead donation
 * never blocks the rest of the queue.
 */
export async function getRetryEligibleDonations(): Promise<QueuedDonation[]> {
  const queue = await readQueue();
  const now = Date.now();
  return queue.filter(
    (d) =>
      (d.status === "pending" || d.status === "retrying") &&
      d.attempts < d.maxAttempts &&
      d.retryable !== false &&
      d.nextRetryAt <= now,
  );
}

/**
 * Alias for getRetryEligibleDonations exposed under the shorter name the
 * issue/spec references. Both return the same retry-eligible set.
 */
export const getRetryEligible = getRetryEligibleDonations;

/**
 * Return the current status of a single queued donation, or null if it is
 * not present in the queue.
 *
 * @param donationId - id of the queued donation
 */
export async function getItemStatus(
  donationId: string,
): Promise<DonationStatus | null> {
  const queue = await readQueue();
  const found = queue.find((d) => d.id === donationId);
  return found ? found.status : null;
}

/**
 * Mark a queued donation as "retrying" (in-flight).
 */
export async function markRetrying(donationId: string): Promise<void> {
  const queue = await readQueue();
  const idx = queue.findIndex((d) => d.id === donationId);
  if (idx === -1) return;
  queue[idx].status = "retrying";
  queue[idx].updatedAt = Date.now();
  await writeQueue(queue);
}

/**
 * Mark a queued donation as successfully submitted.
 */
export async function markSubmitted(
  donationId: string,
  transactionHash: string,
): Promise<void> {
  const queue = await readQueue();
  const idx = queue.findIndex((d) => d.id === donationId);
  if (idx === -1) return;
  queue[idx].status = "submitted";
  queue[idx].transactionHash = transactionHash;
  queue[idx].updatedAt = Date.now();
  await writeQueue(queue);
}

/**
 * Record a failed attempt and schedule the next retry.
 *
 * @param donationId - id of the queued donation
 * @param errorMessage - human-readable error (preserved in lastError)
 * @param options.permanent - when true, the donation is marked failed and
 *        non-retryable immediately (e.g. insufficient balance, deleted
 *        project). Overrides the backoff/exhaust schedule.
 * @param options.errorCode - machine-readable backend error code, stored for
 *        retry classification and UI display.
 */
export async function markFailed(
  donationId: string,
  errorMessage: string,
  options: { permanent?: boolean; errorCode?: string } = {},
): Promise<void> {
  const queue = await readQueue();
  const idx = queue.findIndex((d) => d.id === donationId);
  if (idx === -1) return;

  const d = queue[idx];
  d.attempts += 1;
  d.lastError = errorMessage;
  d.errorCode = options.errorCode ?? d.errorCode;
  d.updatedAt = Date.now();

  const permanent = options.permanent === true || d.attempts >= d.maxAttempts;

  if (permanent) {
    d.status = "failed";
    d.retryable = false; // never picked up by getRetryEligibleDonations
    d.nextRetryAt = 0;
  } else {
    d.status = "pending";
    d.retryable = true;
    // next retry at now + backoff for current attempt count
    const backoffIndex = Math.min(d.attempts - 1, RETRY_BACKOFF_MS.length - 1);
    d.nextRetryAt = Date.now() + RETRY_BACKOFF_MS[backoffIndex];
  }

  await writeQueue(queue);
}

/**
 * Mark a previously failed donation as retryable again so it re-enters the
 * normal backoff schedule. Used by the "Retry" button in the UI.
 *
 * @param donationId - id of the donation to re-queue
 * @param immediate - when true, make it eligible for an immediate retry
 */
export async function retryDonation(
  donationId: string,
  immediate = true,
): Promise<void> {
  const queue = await readQueue();
  const idx = queue.findIndex((d) => d.id === donationId);
  if (idx === -1) return;

  const d = queue[idx];
  d.status = "pending";
  d.retryable = true;
  d.attempts = 0; // fresh attempt budget
  d.lastError = undefined;
  d.errorCode = undefined;
  d.nextRetryAt = immediate ? Date.now() : d.nextRetryAt;
  d.updatedAt = Date.now();

  await writeQueue(queue);
}

/**
 * Remove a single donation from the queue (e.g. user dismiss).
 */
export async function removeDonation(donationId: string): Promise<void> {
  const queue = await readQueue();
  const filtered = queue.filter((d) => d.id !== donationId);
  await writeQueue(filtered);
}

/**
 * Remove all completed/failed donations (garbage collection).
 */
export async function cleanQueue(): Promise<void> {
  const queue = await readQueue();
  const active = queue.filter(
    (d) => d.status === "pending" || d.status === "retrying",
  );
  await writeQueue(active);
}

/**
 * Remove all donations from the queue.
 */
export async function clearQueue(): Promise<void> {
  await AsyncStorage.removeItem(STORAGE_KEY);
}

/**
 * Get full queue summary for status display.
 */
export async function getQueueSummary(): Promise<{
  total: number;
  pending: number;
  retrying: number;
  submitted: number;
  failed: number;
}> {
  const queue = await readQueue();
  return {
    total: queue.length,
    pending: queue.filter((d) => d.status === "pending").length,
    retrying: queue.filter((d) => d.status === "retrying").length,
    submitted: queue.filter((d) => d.status === "submitted").length,
    failed: queue.filter((d) => d.status === "failed").length,
  };
}
