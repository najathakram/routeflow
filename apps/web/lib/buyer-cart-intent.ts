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

/** Row 604 S8: a stored choice older than this is stale (a different day's cart) and is dropped. */
export const FORCE_NEW_TTL_MS = 24 * 60 * 60 * 1000;

/** The choice is stored as the time it was made; a legacy "1" has no time, so it counts as expired. */
function isFresh(raw: string | null): boolean {
  const at = Number(raw);
  return Number.isFinite(at) && at > 1_000_000_000_000 && Date.now() - at < FORCE_NEW_TTL_MS;
}

/** `cartCount` (optional): the choice is cleared when a cart that had lines becomes empty. */
export function useBuyerCartForceNew(
  buyerAccountId?: string,
  sellerSlug?: string,
  cartCount?: number,
) {
  const key = buyerAccountId && sellerSlug ? intentKey(buyerAccountId, sellerSlug) : null;
  const [forceNew, setState] = React.useState(false);

  React.useEffect(() => {
    if (!key) return;
    try {
      const raw = window.localStorage.getItem(key);
      if (isFresh(raw)) setState(true);
      else {
        setState(false);
        if (raw !== null) window.localStorage.removeItem(key);
      }
    } catch {
      // storage blocked: the in-memory choice still holds for this mount
    }
  }, [key]);

  const setForceNew = React.useCallback(
    (next: boolean) => {
      setState(next);
      if (!key) return;
      try {
        if (next) window.localStorage.setItem(key, String(Date.now()));
        else window.localStorage.removeItem(key);
      } catch {
        // storage full or blocked
      }
    },
    [key],
  );

  // Only a cart that HAD lines and is now empty clears it: the first render is empty before the cart hydrates.
  const prevCount = React.useRef<number | undefined>(undefined);
  React.useEffect(() => {
    if (cartCount === undefined) return;
    if ((prevCount.current ?? 0) > 0 && cartCount === 0) setForceNew(false);
    prevCount.current = cartCount;
  }, [cartCount, setForceNew]);

  return [forceNew, setForceNew] as const;
}
