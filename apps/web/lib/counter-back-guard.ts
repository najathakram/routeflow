"use client";

import * as React from "react";
import { guardCounterLeave } from "./counter-cart-signal";

const SENTINEL = "__rfCounterSentinel";

/**
 * POS-7: browser Back / swipe-back while the counter cart has lines. A sentinel history entry is pushed once the cart has
 * lines; Back pops it (same URL, no navigation), so the handler re-pushes it and asks through the shared guard
 * ("Discard this sale?", or the busy notice mid-sale). Discard walks back past the sentinel and the re-push (go(-2)).
 * An empty cart removes the listener; the one sentinel left behind costs a single extra Back press.
 */
export function useCounterBackGuard(active: boolean, onNoPreviousPage: () => void): void {
  const fallback = React.useRef(onNoPreviousPage);
  fallback.current = onNoPreviousPage;
  React.useEffect(() => {
    if (!active || typeof window === "undefined") return;
    // One sentinel only: it is marked in history.state, so a later sale (or a reload) that is already on it pushes nothing.
    const push = () => {
      if (window.history.state?.[SENTINEL]) return;
      window.history.pushState(
        { ...window.history.state, [SENTINEL]: true },
        "",
        window.location.href,
      );
    };
    push();
    const onPop = () => {
      push();
      guardCounterLeave(() => {
        window.removeEventListener("popstate", onPop);
        // A deep link / new tab has no earlier page to walk back to: go(-2) would do nothing.
        if (window.history.length < 3) fallback.current();
        else window.history.go(-2);
      });
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [active]);
}
