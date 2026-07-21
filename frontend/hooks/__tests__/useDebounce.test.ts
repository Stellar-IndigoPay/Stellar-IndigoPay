/**
 * hooks/__tests__/useDebounce.test.ts
 *
 * Validates useDebounce: initial value passthrough, delayed update,
 * only-last-value-emitted on rapid changes, and timer cleanup on unmount.
 */
import { act, renderHook } from "@testing-library/react";
import { useDebounce } from "../useDebounce";

describe("useDebounce", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it("returns the initial value immediately, before any delay elapses", () => {
    const { result } = renderHook(() => useDebounce("initial", 300));
    expect(result.current).toBe("initial");
  });

  it("does not update the returned value before the delay has elapsed", () => {
    const { result, rerender } = renderHook(
      ({ value, delay }) => useDebounce(value, delay),
      { initialProps: { value: "a", delay: 300 } },
    );

    rerender({ value: "b", delay: 300 });
    act(() => {
      jest.advanceTimersByTime(299);
    });
    expect(result.current).toBe("a");
  });

  it("updates to the latest value once the delay has fully elapsed", () => {
    const { result, rerender } = renderHook(
      ({ value, delay }) => useDebounce(value, delay),
      { initialProps: { value: "a", delay: 300 } },
    );

    rerender({ value: "b", delay: 300 });
    act(() => {
      jest.advanceTimersByTime(300);
    });
    expect(result.current).toBe("b");
  });

  it("only emits the last value when the input changes rapidly within the delay window", () => {
    const { result, rerender } = renderHook(
      ({ value, delay }) => useDebounce(value, delay),
      { initialProps: { value: "a", delay: 300 } },
    );

    rerender({ value: "am", delay: 300 });
    act(() => {
      jest.advanceTimersByTime(100);
    });
    rerender({ value: "ama", delay: 300 });
    act(() => {
      jest.advanceTimersByTime(100);
    });
    rerender({ value: "amaz", delay: 300 });
    act(() => {
      jest.advanceTimersByTime(100);
    });
    // Only 300ms total has passed, none of it contiguous — still the
    // original value, since every keystroke reset the timer.
    expect(result.current).toBe("a");

    rerender({ value: "amazon", delay: 300 });
    act(() => {
      jest.advanceTimersByTime(300);
    });
    // Only the final value is ever committed.
    expect(result.current).toBe("amazon");
  });

  it("clears the pending timer on unmount so it never fires after unmount", () => {
    const clearSpy = jest.spyOn(global, "clearTimeout");
    const { unmount, rerender } = renderHook(
      ({ value, delay }) => useDebounce(value, delay),
      { initialProps: { value: "a", delay: 300 } },
    );

    rerender({ value: "b", delay: 300 });
    unmount();

    expect(clearSpy).toHaveBeenCalled();
    // Advancing timers post-unmount must not throw or update anything.
    expect(() => {
      act(() => {
        jest.advanceTimersByTime(1000);
      });
    }).not.toThrow();
    clearSpy.mockRestore();
  });

  it("resets the delay window whenever the delay argument itself changes", () => {
    const { result, rerender } = renderHook(
      ({ value, delay }) => useDebounce(value, delay),
      { initialProps: { value: "a", delay: 300 } },
    );

    rerender({ value: "b", delay: 500 });
    act(() => {
      jest.advanceTimersByTime(300);
    });
    expect(result.current).toBe("a"); // old 300ms delay does not apply anymore
    act(() => {
      jest.advanceTimersByTime(200);
    });
    expect(result.current).toBe("b"); // new 500ms delay has now elapsed
  });
});
