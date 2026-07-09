/**
 * lib/errorReporter.ts
 *
 * Lightweight error reporter used by `components/ErrorBoundary.tsx` and
 * any imperative call sites (e.g. `try { ... } catch (e) { captureException(e); }`).
 *
 * Goals
 * - Single sink for ALL uncaught exceptions so we can later swap the
 *   transport (Sentry / Crashlytics / Datadog) without touching every
 *   call site.
 * - Fire-and-forget: captureException never throws and never blocks
 *   the calling render. If the network is down we just lose the
 *   report — this is a deliberate trade-off vs. busy-write queues
 *   that would amplify storage pressure.
 *
 * Future-proofing Swift native SDKs
 * - If `@sentry/react-native` is resolvable at runtime, errors are also
 *   forwarded to `Sentry.captureException` so production builds get
 *   grouping + release metadata. We do NOT make this a hard
 *   dependency — the wrapper holds the app together even when Sentry
 *   is not installed (CI, dev, OSS forks).
 */
import { Platform } from 'react-native';

const REPORT_ENDPOINT = '/api/errors/report';

export interface ReportContext {
  /** React errorInfo.componentStack or a stringified imperative summary. */
  componentStack?: string;
  /** Optional route path that produced the error (e.g. "/donate/123"). */
  pathname?: string;
  /** Build version reported by `expo-constants` / `app.json`. */
  appVersion?: string;
  /** Whatever additional context a caller wants to attach. */
  [key: string]: unknown;
}

/**
 * Initialise any optional SDKs that fail gracefully: the only side
 * effect today is to attempt `require('@sentry/react-native').init({...})`
 * but never throw on failure. Call once at app startup.
 */
export async function init(): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const sentry = require('@sentry/react-native');
    if (sentry?.init) {
      sentry.init({
        dsn: process.env.EXPO_PUBLIC_SENTRY_DSN,
        // Disable auto breadcrumbs unless the user opted in via env.
        enableAutoPerformanceTracing: false,
      });
    }
  } catch {
    // Sentry is optional; absence is normal.
  }
}

/**
 * Capture a single exception. Returns true if the report was enqueued
 * by the backend POST OR forwarded to Sentry, false if everything was
 * unavailable (in which case the call site should at minimum log the
 * error locally via console.error so developers see it via Metro).
 */
export async function captureException(
  error: Error,
  info: ReportContext = {}
): Promise<boolean> {
  // Always log locally first — Metro / a future dev console can pick
  // this up even if the wrapper has no transport configured.
  if (Platform.OS !== 'web') {
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary]', error?.message ?? String(error), info);
  }

  let sentToBackend = false;
  try {
    const apiUrl = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:4000';
    const body = JSON.stringify({
      message: error?.message ?? String(error),
      stack: error?.stack,
      platform: Platform.OS,
      ...info,
      // `expo-application` reads the version, but only if installed —
      // we omit it for now to avoid a hard dependency.
    });
    const controller = new AbortController();
    // Cap each report at 3 seconds so a stuck network cannot hold the
    // RN bridge open during a render-error fallback.
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${apiUrl}${REPORT_ENDPOINT}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    sentToBackend = res.ok;
  } catch {
    // Network unavailable, backend down, or fetch aborted by our
    // timeout. None of these should propagate to the caller; the goal
    // here is "fire and forget".
  }

  let sentToSentry = false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const sentry = require('@sentry/react-native');
    if (sentry?.captureException) {
      sentry.captureException(error, { extra: info });
      sentToSentry = true;
    }
  } catch {
    // Sentry not installed — silent no-op.
  }

  return sentToBackend || sentToSentry;
}
