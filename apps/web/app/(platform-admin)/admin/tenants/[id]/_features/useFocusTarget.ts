"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";

/** How long a link may wait for its target to mount (a tab switch, a late fetch) before giving up. */
const WAIT_MS = 3000;
/** Breathing room above the target when `scroll-margin-top` is not set on it. */
const DEFAULT_MARGIN_PX = 16;

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Scrolls the page's own scroller (`<main>`, never the window) so `el` is in view, then focuses it. */
function land(el: HTMLElement): void {
  const behavior: ScrollBehavior = prefersReducedMotion() ? "auto" : "smooth";
  const main = el.closest("main");
  if (main) {
    const margin = parseFloat(getComputedStyle(el).scrollMarginTop) || DEFAULT_MARGIN_PX;
    const top = Math.max(
      0,
      main.scrollTop + el.getBoundingClientRect().top - main.getBoundingClientRect().top - margin,
    );
    if (typeof main.scrollTo === "function") main.scrollTo({ top, behavior });
    else main.scrollTop = top;
  } else if (typeof el.scrollIntoView === "function") {
    el.scrollIntoView({ block: "start", behavior });
  }
  el.focus({ preventScroll: true });
}

/** Drops `focus` from the address bar and keeps every other param (and the router's history state). */
function clearFocusParam(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("focus")) return;
  url.searchParams.delete("focus");
  // null state: Next's patched replaceState then copies its own entry state and syncs
  // useSearchParams(); passing the old state back leaves the router still holding `focus`.
  window.history.replaceState(null, "", url.pathname + url.search + url.hash);
}

/**
 * "Take me to that control": when the URL carries `?focus=<key>`, scroll the page's `<main>` to the
 * element and focus it, then remove `focus` from the URL.
 *
 * It follows the URL, not the mount: a tab or same-page link changes `?focus=` with no remount, and
 * every change to the key re-runs it. The element may not exist yet (the tab is still switching), so
 * it waits for it for up to 3 s. A `<fieldset>` cannot take focus: pass the element that can.
 *
 * `ref` names the element; without one the hook looks for `[data-focus-target="<key>"]`, so a
 * component can mark its target without sharing a ref.
 */
export function useFocusTarget(key: string, ref?: React.RefObject<HTMLElement | null>): void {
  const searchParams = useSearchParams();
  const focus = searchParams?.get("focus") ?? null;

  React.useEffect(() => {
    if (focus !== key) return;
    const selector = `[data-focus-target="${key.replace(/"/g, '\\"')}"]`;
    const find = (): HTMLElement | null =>
      ref?.current ?? document.querySelector<HTMLElement>(selector);

    let settled = false;
    let observer: MutationObserver | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const settle = (el: HTMLElement | null) => {
      if (settled) return;
      settled = true;
      observer?.disconnect();
      if (timer !== null) clearTimeout(timer);
      if (el) land(el);
      clearFocusParam();
    };

    const now = find();
    if (now) {
      settle(now);
    } else {
      observer = new MutationObserver(() => {
        const el = find();
        if (el) settle(el);
      });
      observer.observe(document.body, { childList: true, subtree: true });
      timer = setTimeout(() => settle(null), WAIT_MS);
    }

    return () => {
      settled = true;
      observer?.disconnect();
      if (timer !== null) clearTimeout(timer);
    };
  }, [focus, key, ref]);
}
