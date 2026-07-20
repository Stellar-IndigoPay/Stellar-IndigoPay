import { useEffect, useState } from "react";

/**
 * Delays updates to `value` until it has been stable for `delayMs`.
 * Useful for search inputs so each keystroke does not hit the network.
 */
export function useDebounce<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(id);
  }, [value, delayMs]);

  return debounced;
}

export default useDebounce;
