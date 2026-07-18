/**
 * components/__tests__/ErrorBoundary.test.tsx
 *
 * Unit tests for the React Native error boundary in
 * `components/ErrorBoundary.tsx`.
 *
 * Behavior under test:
 *   - children render unchanged when no error is thrown
 *   - thrown child renders the default fallback card with role=alert
 *   - onError fires exactly once with (Error, ErrorInfo)
 *   - captureException is invoked from componentDidCatch
 *   - the Try-again button resets capturedError → children re-render
 *   - error.message is hidden under NODE_ENV='production'
 *   - custom fallback overrides the default
 */
import React, { type ReactNode } from "react";
import { Text, Pressable, View } from "react-native";
import { render, fireEvent, screen } from "@testing-library/react-native";

jest.mock("../../lib/errorReporter", () => ({
  init: jest.fn(),
  captureException: jest.fn().mockResolvedValue(true),
}));

import { ErrorBoundary } from "../ErrorBoundary";
import { captureException } from "../../lib/errorReporter";

const captureExceptionMock = captureException as jest.MockedFunction<
  typeof captureException
>;

function Bomb({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) {
    throw new Error("intentional render error");
  }
  return (
    <View>
      <Text testID="ok">all good</Text>
    </View>
  );
}

function Harness({
  shouldThrow,
  customFallback,
  onError,
}: {
  shouldThrow: boolean;
  customFallback?: (error: Error, retry: () => void) => ReactNode;
  onError?: (error: Error, info: React.ErrorInfo) => void;
}) {
  return (
    <ErrorBoundary fallback={customFallback} onError={onError}>
      <Bomb shouldThrow={shouldThrow} />
    </ErrorBoundary>
  );
}

describe("ErrorBoundary", () => {
  const originalEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    captureExceptionMock.mockClear();
  });

  test("renders children unchanged when no error is thrown", () => {
    render(<Harness shouldThrow={false} />);
    expect(screen.getByTestId("ok")).toBeTruthy();
  });

  test("renders default fallback with role=alert when child throws", () => {
    process.env.NODE_ENV = "development";
    const spy = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    render(<Harness shouldThrow={true} />);
    const alert = screen.getByRole("alert");
    expect(alert).toBeTruthy();
    expect(alert.props.accessibilityLiveRegion).toBe("assertive");
    expect(screen.getByText(/intentional render error/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /retry/i })).toBeTruthy();

    spy.mockRestore();
  });

  test("fires onError callback exactly once per render-cycle error", () => {
    process.env.NODE_ENV = "development";
    const spy = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const onError = jest.fn();
    render(<Harness shouldThrow={true} onError={onError} />);

    expect(onError).toHaveBeenCalledTimes(1);
    const [error, info] = onError.mock.calls[0];
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("intentional render error");
    expect(typeof info.componentStack).toBe("string");
    spy.mockRestore();
  });

  test("componentDidCatch invokes captureException through the reporter", async () => {
    process.env.NODE_ENV = "development";
    const spy = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    render(<Harness shouldThrow={true} />);

    // captureException is called from componentDidCatch without await;
    // the mock resolves a promise we don't observe. Verify the call
    // happened with the correct arguments.
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [err, info] = captureExceptionMock.mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("intentional render error");
    expect(typeof info.componentStack).toBe("string");
    spy.mockRestore();
  });

  test("hides raw error message under NODE_ENV=production", () => {
    process.env.NODE_ENV = "production";
    const spy = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    render(<Harness shouldThrow={true} />);

    const alert = screen.getByRole("alert");
    expect(alert).toBeTruthy();
    // The default fallback body must NOT include the literal "intentional
    // render error" message under production.
    expect(screen.queryByText(/intentional render error/i)).toBeNull();
    expect(
      screen.getByText(
        /unexpected error occurred while rendering this screen/i,
      ),
    ).toBeTruthy();
    spy.mockRestore();
  });

  test("reset button clears capturedError and children re-render", () => {
    process.env.NODE_ENV = "development";
    const spy = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    function ToggleHarness() {
      const [boom, setBoom] = React.useState(true);
      return (
        <ErrorBoundary>
          <Pressable testID="stop-booming" onPress={() => setBoom(false)}>
            <Text>stop</Text>
          </Pressable>
          <Bomb shouldThrow={boom} />
        </ErrorBoundary>
      );
    }
    render(<ToggleHarness />);
    expect(screen.queryByTestId("ok")).toBeNull();

    fireEvent.press(screen.getByTestId("stop-booming"));
    fireEvent.press(screen.getByRole("button", { name: /retry/i }));
    expect(screen.getByTestId("ok")).toBeTruthy();

    spy.mockRestore();
  });

  test("custom fallback overrides the default", () => {
    process.env.NODE_ENV = "development";
    const spy = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const fallback = (error: Error) => (
      <Text testID="custom-fallback">{error.message}</Text>
    );
    render(<Harness shouldThrow={true} customFallback={fallback} />);

    expect(screen.getByTestId("custom-fallback").props.children).toBe(
      "intentional render error",
    );
    expect(screen.queryByRole("alert")).toBeNull();
    spy.mockRestore();
  });
});
