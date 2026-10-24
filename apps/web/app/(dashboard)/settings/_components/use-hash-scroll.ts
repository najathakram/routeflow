import * as React from "react";

function subscribeHash(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

/** The current `#hash` (with the `#`), live. */
export function useLocationHash(): string {
  return React.useSyncExternalStore(
    subscribeHash,
    () => window.location.hash,
    () => "",
  );
}

/** The `#id` as an element id; a malformed escape ("%E0") is not an id, never an exception. */
export function hashId(hash: string): string {
  try {
    return decodeURIComponent(hash.replace(/^#/, ""));
  } catch {
    return "";
  }
}

/**
 * Bring the `#id` target into view once it exists. A tab body is client-rendered after its data loads, so the
 * browser's own hash scroll finds nothing; poll (up to ~8 s, a slow tab body included) and stop when found. The
 * moment the person scrolls, wheels, swipes or presses a key, polling stops: a late card never yanks the page back.
 * Re-runs when `key` (the route + query) or the hash changes. Targets carry `scroll-margin-top`.
 */
const POLL_MS = 100;
const POLL_TRIES = 80;
const USER_SCROLL_EVENTS = ["wheel", "touchmove", "keydown"] as const;

export function useHashScroll(key: string): void {
  const hash = useLocationHash();
  React.useEffect(() => {
    const id = hashId(hash);
    if (!id) return;
    let tries = 0;
    const stop = () => {
      clearInterval(timer);
      for (const ev of USER_SCROLL_EVENTS) window.removeEventListener(ev, stop);
    };
    const timer = setInterval(() => {
      const el = document.getElementById(id);
      if (el) {
        el.scrollIntoView({ block: "start" });
        stop();
      } else if (++tries >= POLL_TRIES) stop();
    }, POLL_MS);
    for (const ev of USER_SCROLL_EVENTS) window.addEventListener(ev, stop, { passive: true });
    return stop;
  }, [key, hash]);
}
