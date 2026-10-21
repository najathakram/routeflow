"use client";

import * as React from "react";

/**
 * Row 695 (F36): the buyer's "Create new order instead" choice, stored per buyer + seller so a
 * remount (browser Back then Forward) reads the same value the banner and the POST were using.
 * It is cleared when the order is placed, so it can never leak into the next cart.
 */
function intentKey(buyerAccountId: string, sellerSlug: string) {
  return `buyerCartForceNew_${buyerAccountId}_${sellerSlug}`;
}

export function useBuyerCartForceNew(buyerAccountId?: string, sellerSlug?: string) {
  const key = buyerAccountId && sellerSlug ? intentKey(buyerAccountId, sellerSlug) : null;
  const [forceNew, setState] = React.useState(false);

  React.useEffect(() => {
    if (!key) return;
    try {
      setState(window.localStorage.getItem(key) === "1");
    } catch {
      // storage blocked: the in-memory choice still holds for this mount
    }
  }, [key]);

  const setForceNew = React.useCallback(
    (next: boolean) => {
      setState(next);
      if (!key) return;
      try {
        if (next) window.localStorage.setItem(key, "1");
        else window.localStorage.removeItem(key);
      } catch {
        // storage full or blocked
      }
    },
    [key],
  );

  return [forceNew, setForceNew] as const;
}
