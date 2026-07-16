/**
 * lib/__tests__/ErrorBoundary.test.tsx
 *
 * Unit tests for the top-level React error boundary.
 * Covers:
 *   1. Default fallback renders a role=alert region and the reset button.
 *   2. Resetting the boundary (clicking the button) renders children again.
 *   3. Custom fallback renderer wins when supplied.
 *   4. onError listener fires with `(error, info)` for listener-side effects
 *      (e.g. integration tests asserting on the captured tuple).
 *   5. Stack trace is hidden in production NODE_ENV.
 */
import React, { type ReactNode } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { ErrorBoundary } from "@/lib/ErrorBoundary";

function Bomb({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) {
    throw new Error("intentional render error");
  }
  return <div data-testid="ok">all good</div>;
}

/** Wraps `Bomb` inside the boundary, optionally injecting a custom fallback. */
function Harness({
  shouldThrow,
  fallback,
  onError,
}: {
  shouldThrow: boolean;
  fallback?: (error: Error, reset: () => void) => ReactNode;
  onError?: (error: Error, info: React.ErrorInfo) => void;
}) {
  return (
    <ErrorBoundary fallback={fallback} onError={onError}>
      <Bomb shouldThrow={shouldThrow} />
    </ErrorBoundary>
  );
}

describe("ErrorBoundary", () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    (process.env as { NODE_ENV: string }).NODE_ENV = originalEnv;
  });

  it("renders children when no error is thrown", () => {
    render(<Harness shouldThrow={false} />);
    expect(screen.getByTestId("ok")).toBeInTheDocument();
  });

  it("renders the default fallback when a child throws", () => {
    // suppress React's unhandled-error console.error so the test output is clean
    const consoleErrorSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});
    render(<Harness shouldThrow={true} />);

    const region = screen.getByRole("alert");
    expect(region).toBeInTheDocument();
    expect(region.textContent).toMatch(/intentional render error/i);
    expect(
      screen.getByRole("button", { name: /reload this section/i }),
    ).toBeInTheDocument();
    consoleErrorSpy.mockRestore();
  });

  it("uses the custom fallback when supplied", () => {
    const consoleErrorSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const fallback = (error: Error) => (
      <div data-testid="custom-fallback">{error.message}</div>
    );
    render(<Harness shouldThrow={true} fallback={fallback} />);

    expect(screen.getByTestId("custom-fallback").textContent).toBe(
      "intentional render error",
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    consoleErrorSpy.mockRestore();
  });

  it("reset button restores the children after an error", () => {
    const consoleErrorSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});
    // Toggle shouldThrow so re-rendering children clears the error.
    // The "stop-booming" button lives OUTSIDE the ErrorBoundary so it
    // remains accessible even while the boundary is showing its fallback.
    function ToggleHarness() {
      const [boom, setBoom] = React.useState(true);
      return (
        <>
          <button data-testid="stop-booming" onClick={() => setBoom(false)}>
            stop
          </button>
          <ErrorBoundary>
            <Bomb shouldThrow={boom} />
          </ErrorBoundary>
        </>
      );
    }
    render(<ToggleHarness />);
    expect(screen.queryByTestId("ok")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("stop-booming"));
    fireEvent.click(
      screen.getByRole("button", { name: /reload this section/i }),
    );
    expect(screen.getByTestId("ok")).toBeInTheDocument();
    consoleErrorSpy.mockRestore();
  });

  it("calls onError with the captured error and component stack info", () => {
    const consoleErrorSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const onError = jest.fn();
    render(<Harness shouldThrow={true} onError={onError} />);

    expect(onError).toHaveBeenCalledTimes(1);
    const [error, info] = onError.mock.calls[0];
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("intentional render error");
    expect(typeof info.componentStack).toBe("string");
    consoleErrorSpy.mockRestore();
  });

  it("exposes the error stack trace outside production", () => {
    (process.env as { NODE_ENV: string }).NODE_ENV = "development";
    const consoleErrorSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});
    render(<Harness shouldThrow={true} />);
    expect(screen.getByTestId("error-boundary-stack")).toBeInTheDocument();
    consoleErrorSpy.mockRestore();
  });

  it("omits the stack trace in production NODE_ENV", () => {
    (process.env as { NODE_ENV: string }).NODE_ENV = "production";
    const consoleErrorSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});
    render(<Harness shouldThrow={true} />);
    expect(
      screen.queryByTestId("error-boundary-stack"),
    ).not.toBeInTheDocument();
    consoleErrorSpy.mockRestore();
  });
});
