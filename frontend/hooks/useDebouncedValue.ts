/**
 * hooks/useDebouncedValue.ts
 *
 * Returns a copy of `value` that only updates after `delayMs` of quiet time.
 * Rapid changes within the window reset the timer, so consumers keyed on the
 * returned value (e.g. a search effect) fire once with the final value
 * instead of once per keystroke.
 *
 * Usage:
 *   const debouncedQuery = useDebouncedValue(query, 250);
 *   useEffect(() => {
 *     if (debouncedQuery) search(debouncedQuery);
 *   }, [debouncedQuery]);
 */
import { useEffect, useState } from "react";

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}

export default useDebouncedValue;
