/**
 * hooks/useDebounce.ts
 *
 * Generic value-debouncing hook. Returns a copy of `value` that only
 * updates after `delay` ms have passed without `value` changing again —
 * used to avoid firing an API call (or any other expensive effect) on
 * every keystroke.
 */
import { useEffect, useState } from "react";

/**
 * Debounces a value by the given delay in milliseconds.
 * Returns the debounced value that only updates after `delay` ms of inactivity.
 *
 * @example
 * const [search, setSearch] = useState("");
 * const debouncedSearch = useDebounce(search, 300);
 * useEffect(() => { fetchProjects({ search: debouncedSearch }); }, [debouncedSearch]);
 */
export function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debouncedValue;
}
