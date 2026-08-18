/**
 * lib/queryErrors.ts
 *
 * Reusable error classification for data-fetching failures.
 *
 * Both the Sentry-backed `ErrorBoundary` (render/runtime exceptions) and the
 * inline `QueryErrorFallback` (network / data-fetch failures) rely on this
 * module to turn a thrown error into a stable category so the UI can show a
 * friendly, type-appropriate message.
 *
 * The classification prefers *structured* error information over brittle
 * string matching:
 *   - Axios errors expose `error.response.status` (HTTP status).
 *   - Axios network failures set `error.code === "ERR_NETWORK"` (or no
 *     response at all) rather than a 4xx/5xx status.
 *   - Plain `Error` / `unknown` values fall back to the "unknown" bucket.
 */

/** Stable categories a thrown error can be reduced to. */
export type QueryErrorKind =
  | "network"
  | "rate-limit" // HTTP 429
  | "server" // HTTP 5xx
  | "client" // HTTP 4xx (other than 429)
  | "unknown";

export interface ClassifiedError {
  /** Machine-readable category. */
  kind: QueryErrorKind;
  /** HTTP status code when available, otherwise null. */
  status: number | null;
  /** Short, user-facing message appropriate for the category. */
  message: string;
  /** True when the failure is worth retrying (network / 429 / 5xx). */
  retryable: boolean;
}

const USER_MESSAGES: Record<QueryErrorKind, string> = {
  network: "Network error. Check your connection.",
  "rate-limit": "Too many requests. Please wait a moment.",
  server: "Server error. Please try again shortly.",
  client: "Failed to load data.",
  unknown: "Failed to load data.",
};

const RETRYABLE: Record<QueryErrorKind, boolean> = {
  network: true,
  "rate-limit": true,
  server: true,
  client: false,
  unknown: true,
};

/**
 * Minimal structural shape we read off Axios-style errors. Keeping this local
 * avoids a hard dependency on the Axios type (which is only present in the
 * browser/Node runtime) and lets the helper work with any object that happens
 * to expose the same fields.
 */
interface AxiosLikeError {
  response?: { status?: number };
  code?: string;
  request?: unknown;
}

function isAxiosLike(value: unknown): value is AxiosLikeError {
  return (
    typeof value === "object" &&
    value !== null &&
    ("response" in value || "code" in value || "request" in value)
  );
}

/**
 * Classify an arbitrary thrown value into a stable error category.
 *
 * @param error - The value caught by a `.catch()` / React Query error handler.
 * @returns A `ClassifiedError` with a user-facing message and retry flag.
 */
export function classifyError(error: unknown): ClassifiedError {
  let kind: QueryErrorKind = "unknown";
  let status: number | null = null;

  if (isAxiosLike(error)) {
    status =
      typeof error.response?.status === "number" ? error.response.status : null;

    if (
      error.code === "ERR_NETWORK" ||
      (status === null && "request" in error)
    ) {
      kind = "network";
    } else if (typeof status === "number") {
      if (status === 429) kind = "rate-limit";
      else if (status >= 500 && status < 600) kind = "server";
      else if (status >= 400 && status < 500) kind = "client";
      else kind = "unknown";
    }
  }

  return {
    kind,
    status,
    message: USER_MESSAGES[kind],
    retryable: RETRYABLE[kind],
  };
}
