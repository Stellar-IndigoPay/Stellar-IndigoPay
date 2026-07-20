import { act, renderHook } from "@testing-library/react";
import { useDebounce } from "@/hooks/useDebounce";

describe("useDebounce", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("returns the initial value immediately", () => {
    const { result } = renderHook(({ v }) => useDebounce(v, 300), {
      initialProps: { v: "hello" },
    });
    expect(result.current).toBe("hello");
  });

  it("does not update before the delay elapses", () => {
    const { result, rerender } = renderHook(({ v }) => useDebounce(v, 300), {
      initialProps: { v: "a" },
    });
    rerender({ v: "ab" });
    act(() => {
      jest.advanceTimersByTime(299);
    });
    expect(result.current).toBe("a");
  });

  it("updates after the delay", () => {
    const { result, rerender } = renderHook(({ v }) => useDebounce(v, 300), {
      initialProps: { v: "a" },
    });
    rerender({ v: "ab" });
    act(() => {
      jest.advanceTimersByTime(300);
    });
    expect(result.current).toBe("ab");
  });

  it("emits only the last value after rapid changes", () => {
    const { result, rerender } = renderHook(({ v }) => useDebounce(v, 300), {
      initialProps: { v: "" },
    });
    rerender({ v: "a" });
    act(() => {
      jest.advanceTimersByTime(100);
    });
    rerender({ v: "am" });
    act(() => {
      jest.advanceTimersByTime(100);
    });
    rerender({ v: "amazon" });
    act(() => {
      jest.advanceTimersByTime(300);
    });
    expect(result.current).toBe("amazon");
  });

  it("cleans up pending timers on unmount", () => {
    const clearSpy = jest.spyOn(window, "clearTimeout");
    const { unmount, rerender } = renderHook(({ v }) => useDebounce(v, 300), {
      initialProps: { v: "x" },
    });
    rerender({ v: "y" });
    unmount();
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});
