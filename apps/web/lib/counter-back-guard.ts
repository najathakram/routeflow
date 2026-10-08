"use client";

import * as React from "react";
import { guardCounterLeave } from "./counter-cart-signal";

/**
 * POS-7: browser Back / swipe-back while the counter cart has lines. A sentinel history entry is pushed once the cart has
 * lines; Back pops it (same URL, no navigation), so the handler re-pushes it and asks through the shared guard
 * ("Discard this sale?", or the busy notice mid-sale). Discard walks back past the sentinel and the re-push (go(-2)).
 * An empty cart removes the listener; the one sentinel left behind costs a single extra Back press.
 */
export function useCounterBackGuard(active: boolean): void {
  React.useEffect(() => {
    if (!active || typeof window === "undefined") return;
    window.history.pushState(window.history.state, "", window.location.href);
    const onPop = () => {
      window.history.pushState(window.history.state, "", window.location.href);
      guardCounterLeave(() => {
        window.removeEventListener("popstate", onPop);
        window.history.go(-2);
      });
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [active]);
}
