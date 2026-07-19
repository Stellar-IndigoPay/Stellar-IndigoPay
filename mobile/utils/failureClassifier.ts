/**
 * utils/failureClassifier.ts
 *
 * Maps a submission failure to a retry decision. Kept separate from the
 * queue/worker so it can be unit-tested in isolation and reused.
 *
 * Classification rules (driven by the backend's AppError `code` and HTTP
 * status, falling back to message/network-error inspection):
 *
 *   Retryable (transient):
 *     - Network errors (no response): ECONNABORTED, ENOTFOUND, ECONNRESET,
 *       timeout, "Network Error"
 *     - HTTP 503 (service unavailable) / 502 (bad gateway) / 504 (gateway
 *       timeout)
 *     - HTTP 429 (rate limited) — backed off by the queue schedule
 *
 *   Permanent (non-retryable):
 *     - PROJECT_NOT_FOUND        → inactive/deleted project
 *     - TX_NOT_FOUND / TX_FAILED → on-chain verification failed (incl.
 *       insufficient balance, bad sequence, etc.)
 *     - VALIDATION_ERROR         → malformed donation payload
 *     - DUPLICATE_DONATION       → already recorded server-side
 *     - Any 4xx other than 429
 *
 * A duplicate (already-recorded) donation is treated as a *success* by the
 * worker, not a failure, so it is never routed here.
 */
import { QueuedDonation } from "./donationQueue";

const PERMANENT_ERROR_CODES = new Set([
  "PROJECT_NOT_FOUND",
  "TX_NOT_FOUND",
  "TX_FAILED",
  "VALIDATION_ERROR",
  "INVALID_ADDRESS",
  "INVALID_TX_HASH",
  "INVALID_STATE_TRANSITION",
  "DUPLICATE_DONATION",
  "SCHEMA_VALIDATION_ERROR",
]);

const RETRYABLE_STATUS_CODES = new Set([502, 503, 504, 429]);

export interface ClassifiedFailure {
  retryable: boolean;
  errorCode?: string;
  reason: string;
}

/**
 * Normalise an arbitrary thrown error from axios into a classified failure.
 *
 * @param err - the caught error (axios error shape expected)
 */
export function classifyFailure(err: any): ClassifiedFailure {
  // Duplicate detection is the caller's job; here we only see genuine errors.
  const response = err?.response;
  const status = response?.status;
  const data = response?.data;
  const code: string | undefined =
    data?.error?.code || data?.code || err?.code;

  // Explicit backend error code — authoritative when present.
  if (code && PERMANENT_ERROR_CODES.has(code)) {
    return {
      retryable: false,
      errorCode: code,
      reason: `Permanent backend error: ${code}`,
    };
  }

  // HTTP status based classification.
  if (typeof status === "number") {
    if (RETRYABLE_STATUS_CODES.has(status)) {
      return {
        retryable: true,
        errorCode: code,
        reason: `Retryable HTTP status: ${status}`,
      };
    }
    // Any other 4xx is a client error → permanent.
    if (status >= 400 && status < 500) {
      return {
        retryable: false,
        errorCode: code,
        reason: `Permanent client error: HTTP ${status}`,
      };
    }
  }

  // No response → network/timeout failure (retryable).
  if (!response) {
    const message = String(err?.message || err?.code || "");
    const isNetwork = /network|timeout|ECONNABORTED|ENOTFOUND|ECONNRESET|ETIMEDOUT/i.test(
      message,
    );
    return {
      retryable: isNetwork || message.length > 0,
      errorCode: code,
      reason: isNetwork ? "Network/timeout error" : "Unknown submission error",
    };
  }

  // Default: treat as permanent to avoid infinite retries on unexpected errors.
  return {
    retryable: false,
    errorCode: code,
    reason: "Unclassified error treated as permanent",
  };
}

/**
 * Convenience: given a completed submission, decide whether the backend
 * reported it as a duplicate of an already-recorded donation.
 */
export function isDuplicateResponse(res: any): boolean {
  return (
    res?.data?.duplicate === true ||
    res?.data?.data?.duplicate === true ||
    res?.status === 200
  );
}

export type { QueuedDonation };
