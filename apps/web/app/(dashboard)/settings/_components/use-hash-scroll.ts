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
 * browser's own hash scroll finds nothing; poll briefly (up to ~3 s) and stop when found. Re-runs when `key`
 * (the route + query) or the hash changes. Targets carry `scroll-margin-top`, so the page title stays visible.
 */
export function useHashScroll(key: string): void {
  const hash = useLocationHash();
  React.useEffect(() => {
    const id = hashId(hash);
    if (!id) return;
    let tries = 0;
    const timer = setInterval(() => {
      const el = document.getElementById(id);
      if (el) {
        el.scrollIntoView({ block: "start" });
        clearInterval(timer);
      } else if (++tries >= 30) clearInterval(timer);
    }, 100);
    return () => clearInterval(timer);
  }, [key, hash]);
}
