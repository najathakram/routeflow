"use client";

import * as React from "react";

/**
 * Mirrors `prefers-reduced-motion: reduce` so the mobile delivery bottom
 * sheet can snap instantly between detents instead of animating `transform`
 * for users who've asked the OS for less motion (owner directive: "honour
 * `prefers-reduced-motion` (snap, no spring)"). SSR-safe: defaults to `false`
 * until the effect below runs client-side, which matches this whole page's
 * existing `!hydrated` gate (see `deliveries/new/page.tsx`) — nothing reads
 * this value before hydration completes.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(false);

  React.useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(query.matches);
    const handler = (e: MediaQueryListEvent) => setReduced(e.matches);
    query.addEventListener("change", handler);
    return () => query.removeEventListener("change", handler);
  }, []);

  return reduced;
}
