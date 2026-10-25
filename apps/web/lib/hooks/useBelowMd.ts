import * as React from "react";

/** Tailwind `md`: below it the page is the phone layout. */
const QUERY = "(min-width: 768px)";

function subscribe(onChange: () => void) {
  const mq = typeof window !== "undefined" ? window.matchMedia?.(QUERY) : undefined;
  mq?.addEventListener?.("change", onChange);
  return () => mq?.removeEventListener?.("change", onChange);
}

/**
 * True below Tailwind's `md` (768px). Read through useSyncExternalStore so the first client render already has the
 * real answer (no desktop layout flashing in before an effect flips it). The server snapshot and jsdom (which has no
 * matchMedia) read false, i.e. the desktop layout.
 */
export function useBelowMd(): boolean {
  return React.useSyncExternalStore(
    subscribe,
    () => {
      const mq = window.matchMedia?.(QUERY);
      return mq ? !mq.matches : false;
    },
    () => false,
  );
}
