import { classifyError } from "./queryErrors";

/**
 * Retry policy for React Query's `retry` option.
 *
 * Retries network, 429, and 5xx failures up to 3 attempts. Never retries
 * 4xx client errors (404, 403, 422, etc.), since those will never succeed
 * on retry and only waste bandwidth / add latency / create noise.
 */
export function queryRetryPolicy(
  failureCount: number,
  error: unknown
): boolean {
  const classified = classifyError(error);
  if (!classified.retryable) return false;
  return failureCount < 3;
}