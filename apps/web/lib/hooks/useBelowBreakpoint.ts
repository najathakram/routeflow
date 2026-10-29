import * as React from "react";

/**
 * Tailwind's `sm` (640px) and `md` (768px): below them a page is its phone layout. The order detail's one-row action bar
 * folds at `sm`; the Orders list's Filters button and the card list fold at `md`.
 */
export type PhoneBreakpoint = "sm" | "md";

const QUERIES: Record<PhoneBreakpoint, string> = {
  sm: "(max-width: 639px)",
  md: "(max-width: 767px)",
};

function subscribeTo(query: string) {
  return (onChange: () => void) => {
    const mq = typeof window !== "undefined" ? window.matchMedia?.(query) : undefined;
    mq?.addEventListener?.("change", onChange);
    return () => mq?.removeEventListener?.("change", onChange);
  };
}

const SUBSCRIBERS: Record<PhoneBreakpoint, (onChange: () => void) => () => void> = {
  sm: subscribeTo(QUERIES.sm),
  md: subscribeTo(QUERIES.md),
};

/**
 * True below the given Tailwind breakpoint. Read through useSyncExternalStore so the first client render already has the
 * real answer (no desktop layout flashing in before an effect flips it). The server snapshot and jsdom (which has no
 * matchMedia) read false, i.e. the desktop layout. This is the ONE phone-breakpoint hook (it replaced useBelowMd and the
 * order detail's usePhoneWidth, which had drifted onto two different widths).
 */
export function useBelowBreakpoint(breakpoint: PhoneBreakpoint): boolean {
  return React.useSyncExternalStore(
    SUBSCRIBERS[breakpoint],
    () => window.matchMedia?.(QUERIES[breakpoint])?.matches ?? false,
    () => false,
  );
}
