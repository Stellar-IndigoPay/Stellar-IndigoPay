/**
 * lib/ErrorBoundary.tsx
 *
 * Top-level React error boundary for the IndigoPay web app.
 *
 * Catches any unhandled render exception thrown anywhere below it in the
 * tree (including async / setState errors during render) and renders a
 * recoverable "something went wrong" fallback instead of letting the page
 * go blank. Recoverable means:
 *
 *   1. The error is reported so we can debug it (best-effort via Sentry).
 *   2. The user sees a friendly explanation rather than a white screen.
 *   3. A "reload this section" button resets the boundary so a retry
 *      doesn't navigate away from the current page.
 *
 * Sentry capture is intentionally lazy + try/caught so the boundary works
 * even if `@sentry/nextjs` isn't loaded yet (e.g. during server-side
 * rendering tests). If Sentry isn't reachable the error still bubbles to
 * the `console.error` sink.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** Optional custom fallback renderer. Defaults to the built-in card UI. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
  /** Optional listener for tests / side-effects; fires before capture. */
  onError?: (error: Error, info: ErrorInfo) => void;
  /** Optional heading label for the built-in fallback. */
  label?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Top-level and nested error boundary. Uses the class-component pattern
 * because React only supports `componentDidCatch` / static
 * `getDerivedStateFromError` on classes.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.props.onError?.(error, info);
    captureError(error, info);
  }

  reset = () => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);

    return (
      <div
        role="alert"
        aria-live="assertive"
        className="card mx-auto my-12 max-w-lg text-center"
      >
        <div className="text-4xl mb-3" aria-hidden>
          {"\ud83d\ude14"}
        </div>
        <h2 className="font-display text-xl font-semibold text-forest-900 mb-2">
          {this.props.label ?? "Something went wrong"}
        </h2>
        <p className="text-sm text-[#5a7a5a] dark:text-[#8aaa8a] font-body mb-4">
          {/* In production, hide the raw error.message (which can leak
              stack traces, internal paths, or other sensitive info) and
              show a generic explanation instead. Developers still see the
              stack preview below when NODE_ENV is not "production". */}
          {!isProduction() && error.message
            ? error.message
            : "An unexpected error occurred while rendering this page."}
        </p>
        {!isProduction() && error.stack && (
          <pre
            data-testid="error-boundary-stack"
            className="text-left text-xs bg-red-50 border border-red-100 rounded p-2 overflow-auto max-h-40 mb-4"
          >
            {error.stack}
          </pre>
        )}
        <button
          type="button"
          onClick={this.reset}
          className="btn-primary"
        >
          Reload this section
        </button>
      </div>
    );
  }
}

export default ErrorBoundary;

/**
 * Best-effort Sentry integration. Lazy plus try/caught so the boundary
 * keeps working in unit tests where `@sentry/nextjs` isn't loaded.
 */
function captureError(error: Error, info: ErrorInfo): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const sentry = require("@sentry/nextjs");
    if (sentry && typeof sentry.captureException === "function") {
      sentry.captureException(error, {
        extra: { componentStack: info.componentStack },
      });
      return;
    }
  } catch {
    // Fall through to the console sink.
  }
  if (typeof console !== "undefined" && console.error) {
    // eslint-disable-next-line no-console
    console.error("[ErrorBoundary]", error, info?.componentStack);
  }
}

/**
 * Edge-runtime-safe NODE_ENV check. `process` may be undefined in the
 * Next.js edge runtime (middleware) or in unusual JS environments, so
 * guard defensively with optional chaining. In any runtime where
 * ErrorBoundary actually renders (server / client), `process` is
 * defined and the value is resolved at build time.
 */
function isProduction(): boolean {
  return process?.env?.NODE_ENV === "production";
}
