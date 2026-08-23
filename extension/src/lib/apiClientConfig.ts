/**
 * extension/src/lib/apiClientConfig.ts
 *
 * Versioned configuration for the shared API transport (`apiClient.ts`):
 * retry/backoff tuning and per-host circuit breaker thresholds.
 *
 * Bumping CONFIG_VERSION signals a behavioral change to anyone reading
 * persisted breaker state (see BREAKER_STORAGE_KEY_PREFIX below) so old
 * and new shapes never get silently mixed after an extension update.
 */

// ── versioning ───────────────────────────────────────────────────────

export const API_CLIENT_CONFIG_VERSION = 1;

// ── retry / backoff ──────────────────────────────────────────────────

export interface RetryConfig {
  /** Maximum number of fetch attempts for a single logical call (>= 1). */
  maxAttempts: number;
  /** Base delay (ms) used to compute exponential backoff. */
  baseDelayMs: number;
  /** Hard ceiling (ms) any single computed backoff delay may reach. */
  maxDelayMs: number;
  /**
   * Fraction (0..1) of the capped exponential delay that is randomized
   * ("jitter") to avoid synchronized retry storms across tabs/users.
   */
  jitterRatio: number;
  /** Per-attempt network timeout (ms) before the attempt is aborted. */
  timeoutMs: number;
  /**
   * Longest `Retry-After` hint (ms) we're willing to sleep inline inside
   * a single bounded retry task. Longer hints instead trip the circuit
   * breaker for the hinted duration so we never block the MV3 service
   * worker on a long, uninterruptible wait.
   */
  maxInlineRetryAfterMs: number;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 300,
  maxDelayMs: 4000,
  jitterRatio: 0.5,
  timeoutMs: 8000,
  maxInlineRetryAfterMs: 10000,
};

/** HTTP status codes treated as retryable (transient) failures. */
export const RETRYABLE_STATUS_CODES: ReadonlySet<number> = new Set([
  408, 429, 500, 502, 503, 504,
]);

// ── circuit breaker ──────────────────────────────────────────────────

export interface CircuitBreakerConfig {
  /** Consecutive failures (closed state) required to trip the breaker. */
  failureThreshold: number;
  /** Time (ms) the breaker stays OPEN before allowing a HALF_OPEN trial. */
  cooldownMs: number;
  /** Consecutive HALF_OPEN trial successes required to fully close. */
  halfOpenSuccessThreshold: number;
  /** Max concurrent trial requests allowed while HALF_OPEN. */
  halfOpenMaxConcurrent: number;
  /**
   * Upper bound (ms) applied when a `Retry-After` hint is used to open
   * the breaker directly, so a misbehaving backend can't wedge the
   * extension "degraded" for an unbounded amount of time.
   */
  maxCooldownMs: number;
}

export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  cooldownMs: 30_000,
  halfOpenSuccessThreshold: 2,
  halfOpenMaxConcurrent: 1,
  maxCooldownMs: 5 * 60_000,
};

// ── storage ──────────────────────────────────────────────────────────

/**
 * chrome.storage.local key prefix used to persist per-host breaker state
 * so it survives MV3 service worker suspension/restart. Namespaced and
 * versioned independently of any other module's storage keys (see
 * extension/src/lib/storage.ts, owned by a separate effort).
 */
export const BREAKER_STORAGE_KEY_PREFIX = `indigopay:apiClient:v${API_CLIENT_CONFIG_VERSION}:breaker:`;
