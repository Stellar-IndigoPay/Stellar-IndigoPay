/**
 * components/ErrorBoundary.tsx
 *
 * Top-level React error boundary for the IndigoPay mobile app.
 *
 * Why
 * - React Native render errors that go uncaught by an ancestor error
 *   boundary result in a white/blank screen with no recovery path on
 *   Android, and on iOS the app sometimes silently terminates the JS
 *   thread. Wrapping the tree in an error boundary gives the user a
 *   deterministic fallback UI plus a Reset button that re-mounts the
 *   children without restarting the app.
 *
 * Production safety
 * - In NODE_ENV=='production', the boundary hides the raw
 *   error.message (which can leak internal paths / secrets) and shows
 *   a generic message instead. Same edge-runtime-safe NODE_ENV check
 *   we use on the web app's ErrorBoundary.
 * - Outside production, preserves the developer-facing message and
 *   prepends the stack so devs can triage from the device log.
 */
import React, { type ErrorInfo, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { captureException } from "../lib/errorReporter";

export interface ErrorBoundaryProps {
  children: ReactNode;
  /**
   * Optional override for the fallback UI. Receives `(error, retry)`
   * so consumers can render their own recovery screen (e.g.
   * "Connection lost" instead of the default).
   */
  fallback?: (error: Error, retry: () => void) => ReactNode;
  /** Optional listener for tests / side-effects. */
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

declare const __DEV__: boolean | undefined;

function isProduction(): boolean {
  const explicit =
    typeof process !== "undefined" && (process as any)?.env?.NODE_ENV === "production";
  return explicit || __DEV__ === false;
}

export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.props.onError?.(error, info);
    // Fire-and-forget; never await inside lifecycle methods (could
    // reenter React eject).
    void captureException(error, {
      componentStack: info.componentStack ?? undefined,
    });
  }

  private retry = () => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.retry);

    const showDetails = !isProduction();

    return (
      <View
        style={styles.container}
        accessible={true}
        accessibilityRole="alert"
        accessibilityLiveRegion="assertive"
      >
        <Text style={styles.icon} accessibilityElementsHidden>
          {"\ud83d\ude14"}
        </Text>
        <Text style={styles.title}>Something went wrong</Text>
        <Text style={styles.body}>
          {showDetails && error
            ? ((error as Error).message || "An unexpected error occurred while rendering this screen.")
            : "An unexpected error occurred while rendering this screen."}
        </Text>
        {showDetails && error.stack ? (
          <Text style={styles.stack} selectable>
            {error.stack}
          </Text>
        ) : null}
        <Pressable
          onPress={this.retry}
          accessibilityRole="button"
          accessibilityLabel="Retry rendering this screen"
          style={({ pressed }) => [
            styles.button,
            pressed ? styles.buttonPressed : null,
          ]}
        >
          <Text style={styles.buttonText}>Try again</Text>
        </Pressable>
      </View>
    );
  }
}

export default ErrorBoundary;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: 24,
    paddingTop: 56,
    alignItems: "center",
    backgroundColor: "#0a1410",
  },
  icon: {
    fontSize: 48,
    marginBottom: 8,
  },
  title: {
    fontSize: 22,
    fontWeight: "700",
    color: "#e8f1ea",
    marginBottom: 8,
    textAlign: "center",
  },
  body: {
    fontSize: 15,
    color: "#a8b8ac",
    textAlign: "center",
    marginBottom: 16,
    lineHeight: 22,
  },
  stack: {
    fontSize: 11,
    color: "#8aa899",
    backgroundColor: "#122019",
    padding: 12,
    borderRadius: 6,
    marginBottom: 16,
    maxHeight: 220,
  },
  button: {
    backgroundColor: "#227239",
    paddingHorizontal: 28,
    paddingVertical: 12,
    borderRadius: 8,
  },
  buttonPressed: {
    opacity: 0.85,
  },
  buttonText: {
    fontSize: 15,
    fontWeight: "600",
    color: "#ffffff",
  },
});
