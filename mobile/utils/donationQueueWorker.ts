/**
 * utils/donationQueueWorker.ts
 *
 * Background retry worker for the offline donation queue.
 *
 * Responsibilities:
 *   - Listens to AppState changes (foreground/background) to trigger retries
 *   - Polls for retry-eligible donations every 30s while app is active
 *   - Submits each eligible donation via POST /api/donations
 *   - Updates queue state (markSubmitted / markFailed) after each attempt
 *   - Stops polling when app goes to background, resumes on foreground
 */
import { AppState, AppStateStatus } from "react-native";
import axios from "axios";
import {
  getRetryEligibleDonations,
  markRetrying,
  markSubmitted,
  markFailed,
  retryDonation,
  QueuedDonation,
} from "./donationQueue";
import { classifyFailure, isDuplicateResponse } from "./failureClassifier";
import {
  subscribe as subscribeConnectivity,
  startConnectivityWatcher,
  stopConnectivityWatcher,
} from "./connectivity";
const API_URL = process.env.EXPO_PUBLIC_API_URL || "http://localhost:4000";

// Polling interval while the app is in the foreground.
const POLL_INTERVAL_MS = 30_000;

// ─── Internal state ─────────────────────────────────────────────────────────

let pollTimer: ReturnType<typeof setInterval> | null = null;
let isRunning = false;
let syncing = false; // guards against concurrent queue processing
let appStateSubscription: any = null;
let connectivitySubscription: (() => void) | null = null;

// ─── Donation submission ───────────────────────────────────────────────────

/**
 * Submit a single queued donation to the backend.
 * Returns the transaction hash on success.
 */
async function submitDonation(
  donation: QueuedDonation,
): Promise<{ transactionHash: string; duplicate: boolean }> {
  const payload: Record<string, any> = {
    projectId: donation.projectId,
    donorAddress: donation.donorAddress,
    amountXLM: donation.currency === "XLM" ? donation.amount : null,
    amount: donation.amount,
    currency: donation.currency,
  };
  if (donation.message) payload.message = donation.message;
  if (donation.transactionHash) payload.transactionHash = donation.transactionHash;

  const res = await axios.post(`${API_URL}/api/donations`, payload, {
    timeout: 15_000,
  });
  const txHash =
    res.data?.data?.transactionHash ||
    res.data?.transactionHash ||
    donation.transactionHash ||
    `tx_${Date.now()}`;
  return { transactionHash: txHash, duplicate: isDuplicateResponse(res) };
}

// ─── Retry logic ──────────────────────────────────────────────────────────

/**
 * Process all retry-eligible donations. Called periodically and on
 * foreground / connectivity-recovery transitions.
 *
 * A re-entrancy guard (syncing) prevents two concurrent passes from both
 * flipping the same donation to "retrying" and double-submitting it.
 */
export async function processQueue(): Promise<{
  submitted: number;
  failed: number;
}> {
  if (syncing) {
    return { submitted: 0, failed: 0 };
  }
  syncing = true;

  let submitted = 0;
  let failed = 0;

  try {
    const eligible = await getRetryEligibleDonations();

    for (const donation of eligible) {
      try {
        // Mark as retrying so it's not picked up by another cycle
        await markRetrying(donation.id);

        const result = await submitDonation(donation);

        if (result.duplicate) {
          // Server already recorded this donation (duplicate tx hash / replay).
          // Treat as completed using the server's response — no error.
          await markSubmitted(donation.id, result.transactionHash);
        } else {
          await markSubmitted(donation.id, result.transactionHash);
        }
        submitted++;
      } catch (err: any) {
        const classification = classifyFailure(err);
        await markFailed(
          donation.id,
          err?.response?.data?.message || err?.message || "Unknown error",
          {
            permanent: classification.retryable === false,
            errorCode: classification.errorCode,
          },
        );
        failed++;
      }
    }
  } catch (err) {
    console.warn("[DonationQueue] Queue processing error:", err);
  } finally {
    syncing = false;
  }

  return { submitted, failed };
}

// ─── Lifecycle ────────────────────────────────────────────────────────────

/**
 * Handle AppState changes: when the app returns to foreground, immediately
 * process the queue and restart the polling timer.
 */
function handleAppStateChange(nextState: AppStateStatus) {
  if (nextState === "active") {
    // App came to foreground — process queue immediately, then start polling
    processQueue().catch(() => {});
    startPolling();
  } else {
    // App went to background — stop polling
    stopPolling();
  }
}

// ─── Connectivity ──────────────────────────────────────────────────────────

/**
 * When connectivity is recovered, auto-retry eligible queued donations.
 * Permanent failures remain untouched (they are excluded by the queue's
 * eligibility filter). Failed middle donations never block later ones
 * because processQueue iterates the whole eligible set independently.
 */
function handleConnectivityChange(online: boolean) {
  if (online) {
    processQueue().catch(() => {});
  }
}

// ─── Polling ──────────────────────────────────────────────────────────────

/**
 * Start the polling timer that processes the queue at regular intervals.
 */
function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    processQueue().catch(() => {});
  }, POLL_INTERVAL_MS);
}

/**
 * Stop the polling timer.
 */
function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/**
 * Start the retry worker. Sets up AppState + connectivity listeners and
 * begins polling. Safe to call multiple times (idempotent).
 */
export function startQueueWorker(): void {
  if (isRunning) return;
  isRunning = true;

  // Register AppState listener
  appStateSubscription = AppState.addEventListener("change", handleAppStateChange);

  // Register connectivity listener (auto-sync on reconnect)
  connectivitySubscription = subscribeConnectivity(handleConnectivityChange);
  startConnectivityWatcher();

  // Start polling for the initial foreground state
  startPolling();

  // Process queue immediately on startup
  processQueue().catch(() => {});
}

/**
 * Stop the retry worker. Cleans up timers and subscriptions.
 * Safe to call multiple times (idempotent).
 */
export function stopQueueWorker(): void {
  stopPolling();

  if (appStateSubscription) {
    appStateSubscription.remove();
    appStateSubscription = null;
  }
  if (connectivitySubscription) {
    connectivitySubscription();
    connectivitySubscription = null;
  }
  stopConnectivityWatcher();

  isRunning = false;
}

/**
 * Manually trigger an immediate queue processing cycle.
 * Useful for the "Retry All Now" button in the UI.
 */
export async function retryAllNow(): Promise<{ submitted: number; failed: number }> {
  return processQueue();
}

/**
 * Re-queue a single failed donation for an immediate retry (UI "Retry" button).
 * No-op if the donation does not exist.
 */
export async function retryDonationNow(donationId: string): Promise<void> {
  await retryDonation(donationId, true);
  await processQueue().catch(() => {});
}

/**
 * Report whether a sync pass is currently in flight. Used by the UI to show a
 * "syncing" indicator and to prevent duplicate manual triggers.
 */
export function isSyncing(): boolean {
  return syncing;
}
