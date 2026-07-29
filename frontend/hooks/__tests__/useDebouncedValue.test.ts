/**
 * hooks/__tests__/useDebouncedValue.test.ts
 *
 * Fake-timer tests for the shared debounce hook: rapid changes within the
 * delay window are coalesced, and the debounced value settles to the final
 * input exactly once after the delay elapses.
 */
import { renderHook, act } from "@testing-library/react";
import { useDebouncedValue } from "../useDebouncedValue";

describe("useDebouncedValue", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("returns the initial value immediately", () => {
    const { result } = renderHook(() => useDebouncedValue("a", 250));
    expect(result.current).toBe("a");
  });

  it("does not update until the delay has elapsed", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedValue(value, 250),
      { initialProps: { value: "a" } },
    );

    rerender({ value: "ab" });
    act(() => {
      jest.advanceTimersByTime(249);
    });
    expect(result.current).toBe("a");

    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(result.current).toBe("ab");
  });

  it("coalesces rapid changes into a single update with the final value", () => {
    const onSettle = jest.fn();
    const { result, rerender } = renderHook(
      ({ value }) => {
        const debounced = useDebouncedValue(value, 250);
        onSettle(debounced);
        return debounced;
      },
      { initialProps: { value: "" } },
    );

    // Simulate rapid typing: each keystroke lands before the window closes.
    for (const value of ["f", "fo", "for", "fore", "fores", "forest"]) {
      rerender({ value });
      act(() => {
        jest.advanceTimersByTime(100); // < 250ms, timer keeps resetting
      });
    }
    // Intermediate values never surfaced.
    expect(result.current).toBe("");

    act(() => {
      jest.advanceTimersByTime(250);
    });
    expect(result.current).toBe("forest");

    // The debounced value only ever settled twice: initial "" and final
    // "forest" — none of the intermediate keystrokes leaked through.
    const settled = [...new Set(onSettle.mock.calls.map(([v]) => v))];
    expect(settled).toEqual(["", "forest"]);
  });

  it("restarts the window when the value changes mid-delay", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedValue(value, 250),
      { initialProps: { value: "a" } },
    );

    rerender({ value: "b" });
    act(() => {
      jest.advanceTimersByTime(200);
    });
    rerender({ value: "c" });
    act(() => {
      jest.advanceTimersByTime(200);
    });
    // 400ms total elapsed, but only 200ms since the last change.
    expect(result.current).toBe("a");

    act(() => {
      jest.advanceTimersByTime(50);
    });
    expect(result.current).toBe("c");
  });

  it("works with non-string values", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedValue(value, 100),
      { initialProps: { value: { page: 1 } } },
    );

    const next = { page: 2 };
    rerender({ value: next });
    act(() => {
      jest.advanceTimersByTime(100);
    });
    expect(result.current).toBe(next);
  });

  it("cancels the pending update on unmount", () => {
    const clearSpy = jest.spyOn(global, "clearTimeout");
    const { rerender, unmount } = renderHook(
      ({ value }) => useDebouncedValue(value, 250),
      { initialProps: { value: "a" } },
    );

    rerender({ value: "b" });
    unmount();
    expect(clearSpy).toHaveBeenCalled();
    // Draining timers after unmount must not throw or warn about state
    // updates on an unmounted component.
    act(() => {
      jest.runOnlyPendingTimers();
    });
    clearSpy.mockRestore();
  });
});
