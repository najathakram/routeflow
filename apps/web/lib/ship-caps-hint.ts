"use client";

import * as React from "react";

/**
 * The three shipping stat slots on the dashboard are reserved while the fulfilment capabilities load ONLY
 * when this tenant last resolved to a SHIP account on this device (so a non-SHIP account never sees a
 * placeholder that then vanishes). First visit / blocked storage => no hint => nothing is reserved.
 * (A TanStack-cached answer is not a hint: with data in the cache the query is not loading at all.)
 */
export const shipHintKey = (slug: string) => `rf-ship-caps:${slug}`;

export function readShipHint(slug: string | null | undefined): boolean {
  if (!slug) return false;
  try {
    return window.localStorage.getItem(shipHintKey(slug)) === "1";
  } catch {
    return false;
  }
}

export function writeShipHint(slug: string | null | undefined, ship: boolean): void {
  if (!slug) return;
  try {
    window.localStorage.setItem(shipHintKey(slug), ship ? "1" : "0");
  } catch {
    /* storage blocked: the hint is a convenience only */
  }
}

const useIsoLayoutEffect = typeof window !== "undefined" ? React.useLayoutEffect : React.useEffect;

/** `loading`: the capabilities answer is in flight. `ship`: the resolved answer (null until it is known). */
export function useShipSlotReserve(
  slug: string | null | undefined,
  loading: boolean,
  ship: boolean | null,
): boolean {
  const [hint, setHint] = React.useState(false);
  useIsoLayoutEffect(() => {
    if (ship !== null) writeShipHint(slug, ship);
    setHint(readShipHint(slug));
  }, [slug, ship]);
  return loading && hint;
}
