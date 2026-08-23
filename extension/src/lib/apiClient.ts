/**
 * extension/src/lib/apiClient.ts
 *
 * Shared transport for background-script API calls: retry-with-backoff,
 * error classification, and a per-host circuit breaker.
 *
 * Design notes (see issue #908):
 *  - Retryable vs non-retryable errors are classified from either an HTTP
 *    status code or a thrown fetch error (network/timeout/abort).
 *  - Backoff is exponential with full jitter, bounded by `maxDelayMs`,
 *    and attempts are always bounded by `maxAttempts` — no unbounded
 *    retry storms.
 *  - The circuit breaker is keyed per-host (not per-endpoint) so that a
 *    single backend outage degrades gracefully across every call site
 *    that talks to it, and concurrent callers share the same state.
 *  - Breaker state is persisted to `chrome.storage.local` (namespaced,
 *    versioned key — see apiClientConfig.ts) so it survives MV3 service
 *    worker suspension/restart. Each retry sleep is a short, bounded
 *    `setTimeout`; we never block on a long uninterruptible wait inside
 *    the worker (see the `Retry-After` handling below).
 *  - Nothing here ever logs request bodies, response bodies, or URLs
 *    with query parameters — only host names and structural metadata
 *    (category, attempt counters, delays).
 *
 * This module does NOT depend on extension/src/lib/storage.ts (a
 * separate, independent effort — issue #909). It talks to
 * `chrome.storage.local` directly under its own namespaced keys.
 */

import {
  BREAKER_STORAGE_KEY_PREFIX,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  DEFAULT_RETRY_CONFIG,
  type CircuitBreakerConfig,
  type RetryConfig,
} from "./apiClientConfig";

// ── error classification ────────────────────────────────────────────

export type ErrorCategory =
  | "network"
  | "timeout"
  | "rate_limit"
  | "server"
  | "client"
  | "aborted"
  | "breaker_open"
  | "unknown";

export interface ClassifiedOutcome {
  retryable: boolean;
  category: ErrorCategory;
}

/** Classify an HTTP response status code as retryable or not. */
export function classifyHttpStatus(status: number): ClassifiedOutcome {
  if (status === 429) return { retryable: true, category: "rate_limit" };
  if (status === 408) return { retryable: true, category: "timeout" };
  if (status >= 500 && status <= 599) {
    return { retryable: true, category: "server" };
  }
  if (status >= 400 && status < 500) {
    return { retryable: false, category: "client" };
  }
  return { retryable: false, category: "unknown" };
}

/** Classify a thrown fetch/timeout/abort error as retryable or not. */
export function classifyError(err: unknown): ClassifiedOutcome {
  if (isAbortError(err)) {
    return { retryable: false, category: "aborted" };
  }
  if (isTimeoutError(err)) {
    return { retryable: true, category: "timeout" };
  }
  // fetch() rejects with a TypeError for network-level failures: DNS
  // failure, connection refused, offline browser, CORS, etc.
  if (err instanceof TypeError) {
    return { retryable: true, category: "network" };
  }
  return { retryable: true, category: "unknown" };
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof DOMException &&
    err.name === "AbortError"
  ) || (err as { name?: string } | null)?.name === "AbortError";
}

function isTimeoutError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === "TimeoutError") ||
    (err as { name?: string } | null)?.name === "TimeoutError"
  );
}

// ── backoff ──────────────────────────────────────────────────────────

/**
 * Exponential backoff with full jitter, bounded by `maxDelayMs`.
 *
 * attempt=1 -> ~baseDelayMs, attempt=2 -> ~baseDelayMs*2, etc., capped.
 * `randomFn` is injectable for deterministic tests (defaults to Math.random).
 */
export function computeBackoffDelayMs(
  attempt: number,
  config: Pick<RetryConfig, "baseDelayMs" | "maxDelayMs" | "jitterRatio">,
  randomFn: () => number = Math.random,
): number {
  const exponential = config.baseDelayMs * Math.pow(2, Math.max(0, attempt - 1));
  const capped = Math.min(exponential, config.maxDelayMs);
  const jitterSpan = capped * clamp01(config.jitterRatio);
  const floor = capped - jitterSpan;
  const jittered = floor + randomFn() * jitterSpan;
  return Math.round(Math.max(0, Math.min(jittered, config.maxDelayMs)));
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** Parse a `Retry-After` header value (seconds or HTTP-date) into ms. */
export function parseRetryAfterMs(headerValue: string | null | undefined): number | null {
  if (!headerValue) return null;
  const trimmed = headerValue.trim();
  if (/^\d+$/.test(trimmed)) {
    return Math.max(0, Number(trimmed) * 1000);
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return null;
}

// ── error type ───────────────────────────────────────────────────────

export interface ApiClientErrorOptions {
  category: ErrorCategory;
  retryable: boolean;
  breakerOpen: boolean;
  attempts: number;
  host: string;
  retryAfterMs?: number;
  cause?: unknown;
}

export class ApiClientError extends Error {
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly breakerOpen: boolean;
  readonly attempts: number;
  readonly host: string;
  readonly retryAfterMs?: number;

  constructor(message: string, opts: ApiClientErrorOptions) {
    super(message);
    this.name = "ApiClientError";
    this.category = opts.category;
    this.retryable = opts.retryable;
    this.breakerOpen = opts.breakerOpen;
    this.attempts = opts.attempts;
    this.host = opts.host;
    this.retryAfterMs = opts.retryAfterMs;
    if (opts.cause !== undefined) {
      (this as { cause?: unknown }).cause = opts.cause;
    }
  }
}

// ── circuit breaker state ───────────────────────────────────────────

export type BreakerState = "closed" | "open" | "half_open";

export interface BreakerRecord {
  state: BreakerState;
  consecutiveFailures: number;
  openedAt: number | null;
  /** Override for cooldownMs, e.g. honoring a long Retry-After hint. */
  cooldownOverrideMs: number | null;
  halfOpenInFlight: number;
  halfOpenSuccesses: number;
  updatedAt: number;
  /**
   * Bumped on every state transition (closed→open, open→half_open,
   * half_open→open, half_open→closed). A permission captures the
   * generation in effect when it was granted; an outcome recorded against
   * a since-changed generation is a no-op (see `acquireBreakerPermission`
   * / `recordBreakerSuccess` / `recordBreakerFailure`) so a request
   * admitted under an old epoch can't rewrite a breaker record that has
   * since moved on to a new one.
   */
  generation: number;
}

export interface BreakerSnapshot {
  host: string;
  state: BreakerState;
  consecutiveFailures: number;
  openedAt: number | null;
  /** ms until the breaker will allow a half-open trial (0 if not open). */
  retryAfterMs: number;
}

const INITIAL_BREAKER_RECORD: BreakerRecord = {
  state: "closed",
  consecutiveFailures: 0,
  openedAt: null,
  cooldownOverrideMs: null,
  halfOpenInFlight: 0,
  halfOpenSuccesses: 0,
  updatedAt: 0,
  generation: 0,
};

// In-memory cache of breaker records, hydrated lazily from
// chrome.storage.local. Cleared by __resetApiClientRuntimeStateForTests
// to simulate an MV3 service worker restart in tests.
const breakerCache = new Map<string, BreakerRecord>();
const breakerLoadPromises = new Map<string, Promise<BreakerRecord>>();

function storageGet(key: string): Promise<unknown> {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get([key], (result: { [key: string]: unknown }) => {
        resolve(result ? result[key] : undefined);
      });
    } catch {
      resolve(undefined);
    }
  });
}

function storageSet(key: string, value: unknown): Promise<void> {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set({ [key]: value }, () => resolve());
    } catch {
      resolve();
    }
  });
}

async function loadBreakerRecord(host: string): Promise<BreakerRecord> {
  const cached = breakerCache.get(host);
  if (cached) return cached;

  const pending = breakerLoadPromises.get(host);
  if (pending) return pending;

  const loadPromise = (async () => {
    const stored = await storageGet(BREAKER_STORAGE_KEY_PREFIX + host);
    const record: BreakerRecord =
      stored && typeof stored === "object"
        ? { ...INITIAL_BREAKER_RECORD, ...(stored as Partial<BreakerRecord>) }
        : { ...INITIAL_BREAKER_RECORD };
    breakerCache.set(host, record);
    return record;
  })();

  breakerLoadPromises.set(host, loadPromise);
  try {
    return await loadPromise;
  } finally {
    breakerLoadPromises.delete(host);
  }
}

async function saveBreakerRecord(host: string, record: BreakerRecord): Promise<BreakerRecord> {
  breakerCache.set(host, record);
  await storageSet(BREAKER_STORAGE_KEY_PREFIX + host, record);
  return record;
}

/**
 * Clears in-memory breaker caches (not chrome.storage) so the next call
 * re-hydrates from storage — used by tests to simulate a service worker
 * restart. Not used in production code paths.
 */
export function __resetApiClientRuntimeStateForTests(): void {
  breakerCache.clear();
  breakerLoadPromises.clear();
}

// ── breaker events (for UI / metrics wiring) ────────────────────────

export interface BreakerEvent {
  type: "breaker_open" | "breaker_half_open" | "breaker_closed";
  host: string;
  at: number;
}

const breakerListeners = new Set<(event: BreakerEvent) => void>();

/** Subscribe to breaker state transitions (in-process only). */
export function subscribeBreakerEvents(listener: (event: BreakerEvent) => void): () => void {
  breakerListeners.add(listener);
  return () => breakerListeners.delete(listener);
}

function emitBreakerEvent(type: BreakerEvent["type"], host: string): void {
  const event: BreakerEvent = { type, host, at: Date.now() };
  logEvent(type, { host });
  breakerListeners.forEach((listener) => {
    try {
      listener(event);
    } catch {
      // Never let a listener error break the transport.
    }
  });
}

// ── metrics/log events (extension-local, no PII) ────────────────────

function logEvent(name: string, data: Record<string, unknown> = {}): void {
  // Only structural metadata is ever logged here: host names, error
  // categories, attempt counters, delays, and breaker state. Never
  // request/response bodies, donation amounts, wallet addresses, or
  // full URLs (which may carry query params).
  console.info(`[apiClient] ${name}`, data);
}

// ── breaker permission / outcome recording ──────────────────────────

function effectiveCooldownMs(record: BreakerRecord, config: CircuitBreakerConfig): number {
  return record.cooldownOverrideMs ?? config.cooldownMs;
}

type BreakerPermission =
  | { allowed: true; trial: boolean; generation: number }
  | { allowed: false; retryAfterMs: number };

// acquireBreakerPermission / recordBreakerSuccess / recordBreakerFailure /
// releaseBreakerTrialSlot all do a read-modify-write against the same
// per-host record (in-memory cache + chrome.storage.local). Concurrent
// apiFetch() calls to the same host can interleave at the `await` points
// inside those reads and writes, which would otherwise lose updates (e.g.
// two concurrent failures both reading consecutiveFailures=n and both
// writing n+1, undercounting the threshold). Route every mutation through
// a per-host promise chain so each read-modify-write completes before the
// next one starts.
const breakerUpdateQueues = new Map<string, Promise<unknown>>();

function withBreakerLock<T>(host: string, task: () => Promise<T>): Promise<T> {
  const previous = breakerUpdateQueues.get(host) ?? Promise.resolve();
  const next = previous.then(task, task);
  breakerUpdateQueues.set(host, next.then(() => undefined, () => undefined));
  return next;
}

async function acquireBreakerPermission(
  host: string,
  config: CircuitBreakerConfig,
): Promise<BreakerPermission> {
  return withBreakerLock(host, () => acquireBreakerPermissionLocked(host, config));
}

async function acquireBreakerPermissionLocked(
  host: string,
  config: CircuitBreakerConfig,
): Promise<BreakerPermission> {
  const record = await loadBreakerRecord(host);
  const now = Date.now();

  if (record.state === "closed") {
    return { allowed: true, trial: false, generation: record.generation };
  }

  if (record.state === "open") {
    const openedAt = record.openedAt ?? now;
    const cooldownMs = effectiveCooldownMs(record, config);
    const elapsed = now - openedAt;
    if (elapsed >= cooldownMs) {
      const generation = record.generation + 1;
      await saveBreakerRecord(host, {
        ...record,
        state: "half_open",
        halfOpenInFlight: 1,
        halfOpenSuccesses: 0,
        updatedAt: now,
        generation,
      });
      emitBreakerEvent("breaker_half_open", host);
      return { allowed: true, trial: true, generation };
    }
    return { allowed: false, retryAfterMs: cooldownMs - elapsed };
  }

  // half_open
  // A trial slot whose outcome never got recorded (the caller cancelled,
  // or the MV3 worker was killed mid-trial) must not hold the breaker in
  // half_open forever — treat it as expired once it's older than the
  // cooldown. `apiFetch` also proactively releases its own slot on every
  // cancellation path (see `releaseBreakerTrialSlot`); this is the
  // defense-in-depth path for a slot that never got released at all.
  const trialIsStale = now - record.updatedAt > effectiveCooldownMs(record, config);
  const inFlight = trialIsStale ? 0 : record.halfOpenInFlight;
  if (inFlight < config.halfOpenMaxConcurrent) {
    await saveBreakerRecord(host, {
      ...record,
      halfOpenInFlight: inFlight + 1,
      updatedAt: now,
    });
    return { allowed: true, trial: true, generation: record.generation };
  }
  return { allowed: false, retryAfterMs: effectiveCooldownMs(record, config) };
}

/**
 * Release a half-open trial slot without recording a success or failure —
 * used on every cancellation path in `apiFetch` so an aborted trial can't
 * permanently occupy `halfOpenMaxConcurrent` and wedge the breaker open
 * forever (see `acquireBreakerPermission`'s stale-trial fallback for the
 * complementary defense against a slot that never gets released at all,
 * e.g. a hard worker kill).
 */
async function releaseBreakerTrialSlot(
  host: string,
  wasTrial: boolean,
  generation: number,
): Promise<void> {
  if (!wasTrial) return;
  await withBreakerLock(host, async () => {
    const record = await loadBreakerRecord(host);
    if (record.state !== "half_open" || record.generation !== generation) return;
    await saveBreakerRecord(host, {
      ...record,
      halfOpenInFlight: Math.max(0, record.halfOpenInFlight - 1),
      updatedAt: Date.now(),
    });
  });
}

async function recordBreakerSuccess(
  host: string,
  config: CircuitBreakerConfig,
  wasTrial: boolean,
  generation: number,
): Promise<BreakerRecord> {
  return withBreakerLock(host, () => recordBreakerSuccessLocked(host, config, wasTrial, generation));
}

async function recordBreakerSuccessLocked(
  host: string,
  config: CircuitBreakerConfig,
  wasTrial: boolean,
  generation: number,
): Promise<BreakerRecord> {
  const record = await loadBreakerRecord(host);
  const now = Date.now();

  // The permission that authorized this outcome was granted against an
  // earlier generation of the record (the breaker has since opened,
  // closed, or re-opened again due to other concurrent requests) — that
  // epoch is gone, so this outcome no longer applies to it. Returning the
  // current record unmodified keeps callers' `updated.state` checks
  // accurate without letting a stale success rewrite live breaker state
  // (see the `generation` field doc comment on `BreakerRecord`).
  if (record.generation !== generation) return record;

  if (record.state === "half_open" && wasTrial) {
    const successes = record.halfOpenSuccesses + 1;
    const inFlight = Math.max(0, record.halfOpenInFlight - 1);
    if (successes >= config.halfOpenSuccessThreshold) {
      const closed = await saveBreakerRecord(host, {
        ...INITIAL_BREAKER_RECORD,
        updatedAt: now,
        generation: record.generation + 1,
      });
      emitBreakerEvent("breaker_closed", host);
      return closed;
    }
    return saveBreakerRecord(host, {
      ...record,
      halfOpenSuccesses: successes,
      halfOpenInFlight: inFlight,
      updatedAt: now,
    });
  }

  if (record.state !== "closed" || record.consecutiveFailures !== 0) {
    return saveBreakerRecord(host, {
      ...INITIAL_BREAKER_RECORD,
      updatedAt: now,
      generation: record.generation + 1,
    });
  }
  return record;
}

async function recordBreakerFailure(
  host: string,
  config: CircuitBreakerConfig,
  wasTrial: boolean,
  generation: number,
  forceOpenCooldownMs?: number,
): Promise<BreakerRecord> {
  return withBreakerLock(host, () =>
    recordBreakerFailureLocked(host, config, wasTrial, generation, forceOpenCooldownMs),
  );
}

async function recordBreakerFailureLocked(
  host: string,
  config: CircuitBreakerConfig,
  wasTrial: boolean,
  generation: number,
  forceOpenCooldownMs?: number,
): Promise<BreakerRecord> {
  const record = await loadBreakerRecord(host);
  const now = Date.now();

  // See the matching guard in `recordBreakerSuccessLocked`: a permission
  // from an earlier generation can't mutate a record that has since moved
  // on to a new epoch.
  if (record.generation !== generation) return record;

  if (record.state === "half_open" && wasTrial) {
    const reopened = await saveBreakerRecord(host, {
      ...record,
      state: "open",
      openedAt: now,
      // Always record the cooldown actually in effect for this open
      // period — a Retry-After hint overrides it, otherwise it's this
      // call's own (possibly non-default) config.cooldownMs. This is what
      // getBreakerSnapshot() reads, so a caller using a custom breaker
      // config gets an accurate retryAfterMs instead of one computed from
      // DEFAULT_CIRCUIT_BREAKER_CONFIG.
      cooldownOverrideMs: forceOpenCooldownMs ?? config.cooldownMs,
      halfOpenInFlight: Math.max(0, record.halfOpenInFlight - 1),
      halfOpenSuccesses: 0,
      updatedAt: now,
      generation: record.generation + 1,
    });
    emitBreakerEvent("breaker_open", host);
    return reopened;
  }

  const failures = record.consecutiveFailures + 1;
  if (forceOpenCooldownMs != null || failures >= config.failureThreshold) {
    const opened = await saveBreakerRecord(host, {
      state: "open",
      consecutiveFailures: failures,
      openedAt: now,
      cooldownOverrideMs: forceOpenCooldownMs ?? config.cooldownMs,
      halfOpenInFlight: 0,
      halfOpenSuccesses: 0,
      updatedAt: now,
      generation: record.generation + 1,
    });
    emitBreakerEvent("breaker_open", host);
    return opened;
  }

  return saveBreakerRecord(host, { ...record, consecutiveFailures: failures, updatedAt: now });
}

/** Read the current breaker state for a host (for UI / diagnostics). */
export async function getBreakerSnapshot(host: string): Promise<BreakerSnapshot> {
  const record = await loadBreakerRecord(host);
  const now = Date.now();
  let retryAfterMs = 0;
  if (record.state === "open") {
    const openedAt = record.openedAt ?? now;
    // recordBreakerFailure() always stamps cooldownOverrideMs with the
    // cooldown actually in effect (a Retry-After hint, or that call's own
    // possibly-custom config.cooldownMs) whenever it opens the breaker, so
    // this only falls back to the default for a record that somehow
    // predates that (there is no such live path today, but this keeps the
    // snapshot correct rather than silently wrong if one appears).
    const cooldownMs = record.cooldownOverrideMs ?? DEFAULT_CIRCUIT_BREAKER_CONFIG.cooldownMs;
    retryAfterMs = Math.max(0, cooldownMs - (now - openedAt));
  }
  return {
    host,
    state: record.state,
    consecutiveFailures: record.consecutiveFailures,
    openedAt: record.openedAt,
    retryAfterMs,
  };
}

// ── url / host helpers ───────────────────────────────────────────────

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "unknown";
  }
}

// ── sleep with cancellation ──────────────────────────────────────────

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    signal?.addEventListener("abort", onAbort);
  });
}

// ── timeout-bounded fetch ───────────────────────────────────────────

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(new DOMException("Timeout", "TimeoutError"));
  }, timeoutMs);

  const onExternalAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort(externalSignal.reason);
    } else {
      externalSignal.addEventListener("abort", onExternalAbort);
    }
  }

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    // Normalize: if our internal timeout fired, surface it as a
    // TimeoutError regardless of how the runtime's fetch reports it.
    if (!externalSignal?.aborted && controller.signal.aborted) {
      throw new DOMException("Timeout", "TimeoutError");
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
    if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
  }
}

// ── public transport ─────────────────────────────────────────────────

export interface ApiFetchOptions {
  retry?: Partial<RetryConfig>;
  breaker?: Partial<CircuitBreakerConfig>;
  /** User-initiated cancellation (e.g. popup closed, user clicked cancel). */
  signal?: AbortSignal;
}

/**
 * Fetch with retry-with-backoff and a per-host circuit breaker.
 *
 * Behavior:
 *  - If the breaker is OPEN (and cooldown hasn't elapsed), throws
 *    ApiClientError({ breakerOpen: true }) without touching the network.
 *  - Retryable HTTP statuses (408/429/5xx) and network/timeout errors are
 *    retried with exponential backoff + jitter, bounded by maxAttempts.
 *  - A `Retry-After` header on a 429 is honored: short waits happen
 *    inline; waits longer than `maxInlineRetryAfterMs` instead trip the
 *    breaker for the hinted duration (capped by `maxCooldownMs`) rather
 *    than blocking the caller.
 *  - Non-retryable HTTP errors (4xx other than 408/429) are returned as
 *    a normal (non-ok) Response, matching native fetch() semantics, so
 *    existing `if (!res.ok)` call sites keep working unchanged.
 *  - Network/timeout errors that exhaust all attempts, and breaker-open
 *    short-circuits, are thrown as ApiClientError (there's no Response
 *    to hand back).
 *  - User cancellation (`options.signal` or `init.signal` aborted) stops
 *    immediately, doesn't count as a breaker failure, and throws
 *    ApiClientError({ category: "aborted" }).
 */
export async function apiFetch(
  url: string,
  init: RequestInit = {},
  options: ApiFetchOptions = {},
): Promise<Response> {
  const host = hostOf(url);
  const retryConfig: RetryConfig = { ...DEFAULT_RETRY_CONFIG, ...options.retry };
  const breakerConfig: CircuitBreakerConfig = { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, ...options.breaker };
  const externalSignal = options.signal ?? (init.signal as AbortSignal | undefined) ?? undefined;

  const permission = await acquireBreakerPermission(host, breakerConfig);
  if (!permission.allowed) {
    logEvent("breaker_short_circuit", { host, retryAfterMs: permission.retryAfterMs });
    throw new ApiClientError("API temporarily unavailable (circuit breaker open)", {
      category: "breaker_open",
      retryable: false,
      breakerOpen: true,
      attempts: 0,
      host,
      retryAfterMs: permission.retryAfterMs,
    });
  }
  const isTrial = permission.trial;
  const generation = permission.generation;

  for (let attempt = 1; attempt <= retryConfig.maxAttempts; attempt++) {
    if (externalSignal?.aborted) {
      await releaseBreakerTrialSlot(host, isTrial, generation);
      throw new ApiClientError("Request cancelled", {
        category: "aborted",
        retryable: false,
        breakerOpen: false,
        attempts: attempt - 1,
        host,
      });
    }

    try {
      const res = await fetchWithTimeout(url, init, retryConfig.timeoutMs, externalSignal);

      if (res.ok) {
        await recordBreakerSuccess(host, breakerConfig, isTrial, generation);
        if (attempt > 1) logEvent("retry_succeeded", { host, attempt });
        return res;
      }

      const { retryable, category } = classifyHttpStatus(res.status);

      if (category === "rate_limit") {
        const retryAfterMs = parseRetryAfterMs(res.headers.get("Retry-After"));
        if (retryAfterMs != null && retryAfterMs > retryConfig.maxInlineRetryAfterMs) {
          const cooldown = Math.min(retryAfterMs, breakerConfig.maxCooldownMs);
          await recordBreakerFailure(host, breakerConfig, isTrial, generation, cooldown);
          logEvent("retry_after_breaker_trip", { host, retryAfterMs: cooldown });
          return res;
        }
        const updated = await recordBreakerFailure(host, breakerConfig, isTrial, generation);
        if (updated.state !== "open" && attempt < retryConfig.maxAttempts) {
          const delay = retryAfterMs ?? computeBackoffDelayMs(attempt, retryConfig);
          logEvent("retry_scheduled", { host, attempt, delay, reason: category });
          await sleep(delay, externalSignal);
          continue;
        }
        return res;
      }

      const updated = await recordBreakerFailure(host, breakerConfig, isTrial, generation);
      if (updated.state !== "open" && retryable && attempt < retryConfig.maxAttempts) {
        const delay = computeBackoffDelayMs(attempt, retryConfig);
        logEvent("retry_scheduled", { host, attempt, delay, reason: category });
        await sleep(delay, externalSignal);
        continue;
      }
      return res;
    } catch (err) {
      if (externalSignal?.aborted) {
        await releaseBreakerTrialSlot(host, isTrial, generation);
        throw new ApiClientError("Request cancelled", {
          category: "aborted",
          retryable: false,
          breakerOpen: false,
          attempts: attempt,
          host,
          cause: err,
        });
      }
      if (isAbortError(err)) {
        // Aborted, but not by our external signal or our own timeout
        // controller in a way we recognize — treat as non-retryable.
        await releaseBreakerTrialSlot(host, isTrial, generation);
        throw new ApiClientError("Request aborted", {
          category: "aborted",
          retryable: false,
          breakerOpen: false,
          attempts: attempt,
          host,
          cause: err,
        });
      }

      const { retryable, category } = classifyError(err);
      const updated = await recordBreakerFailure(host, breakerConfig, isTrial, generation);

      if (updated.state !== "open" && retryable && attempt < retryConfig.maxAttempts) {
        const delay = computeBackoffDelayMs(attempt, retryConfig);
        logEvent("retry_scheduled", { host, attempt, delay, reason: category });
        await sleep(delay, externalSignal);
        continue;
      }

      throw new ApiClientError(`API request failed (${category})`, {
        category,
        retryable,
        breakerOpen: updated.state === "open",
        attempts: attempt,
        host,
        cause: err,
      });
    }
  }

  // Unreachable (loop always returns or throws), but keeps TS satisfied.
  throw new ApiClientError("API request failed (exhausted attempts)", {
    category: "unknown",
    retryable: false,
    breakerOpen: false,
    attempts: retryConfig.maxAttempts,
    host,
  });
}
