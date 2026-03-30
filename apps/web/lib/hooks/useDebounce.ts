import { useState, useEffect } from "react";

/**
 * Debounces a value by the given delay (ms).
 * Useful for search inputs that trigger API calls.
 */
export function useDebounce<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}
