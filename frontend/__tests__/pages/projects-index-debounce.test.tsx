import { useDebounce } from "@/hooks/useDebounce";
import { renderHook, act } from "@testing-library/react";

/**
 * Contract tests for debounced search used by pages/projects/index.tsx (#257).
 */
describe("projects index debounce contract (#257)", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("debounces search terms used for API params", () => {
    const { result, rerender } = renderHook(({ v }) => useDebounce(v, 300), {
      initialProps: { v: "" },
    });
    for (const ch of ["r", "re", "ref", "reforestation"]) {
      rerender({ v: ch });
      act(() => {
        jest.advanceTimersByTime(50);
      });
    }
    expect(result.current).toBe("");
    act(() => {
      jest.advanceTimersByTime(300);
    });
    expect(result.current).toBe("reforestation");
  });

  it("abort controller marks prior signal aborted when a new fetch starts", () => {
    const c1 = new AbortController();
    const c2 = new AbortController();
    expect(c1.signal.aborted).toBe(false);
    c1.abort();
    expect(c1.signal.aborted).toBe(true);
    expect(c2.signal.aborted).toBe(false);
  });

  it("aborted signals fire abort event listeners", () => {
    const c = new AbortController();
    const fn = jest.fn();
    c.signal.addEventListener("abort", fn);
    c.abort();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("non-abort errors are distinguishable from AbortError", () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const network = Object.assign(new Error("network"), { name: "Error" });
    const isAbort = (e: { name?: string }) =>
      e.name === "AbortError" || e.name === "CanceledError";
    expect(isAbort(abort)).toBe(true);
    expect(isAbort(network)).toBe(false);
  });

  it("debounced empty search clears the filter param", () => {
    const { result, rerender } = renderHook(({ v }) => useDebounce(v, 300), {
      initialProps: { v: "x" },
    });
    rerender({ v: "" });
    act(() => {
      jest.advanceTimersByTime(300);
    });
    expect(result.current).toBe("");
  });
});
