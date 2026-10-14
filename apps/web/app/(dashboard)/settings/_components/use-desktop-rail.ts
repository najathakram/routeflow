import * as React from "react";

/** Tailwind `xl`: the rail layout starts here (at lg the content pane would be ~364px); below it the hub is one list. */
const QUERY = "(min-width: 1280px)";

function subscribe(onChange: () => void) {
  const mq = typeof window !== "undefined" ? window.matchMedia?.(QUERY) : undefined;
  mq?.addEventListener("change", onChange);
  return () => mq?.removeEventListener("change", onChange);
}

/** True at xl and up. Server and first paint read false (the one-list layout); jsdom has no matchMedia. */
export function useDesktopRail(): boolean {
  return React.useSyncExternalStore(
    subscribe,
    () => window.matchMedia?.(QUERY).matches ?? false,
    () => false,
  );
}
