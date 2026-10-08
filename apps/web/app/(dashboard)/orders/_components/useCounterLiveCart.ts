import * as React from "react";
import { readHeldAttempt } from "@/lib/counter-sale";
import {
  clearLiveCart,
  readLiveCart,
  writeLiveCart,
  type LiveCartSnapshot,
} from "@/lib/counter-live-cart";

const SAVE_DELAY_MS = 400;

/**
 * SA-748 section 1: the unfinished counter sale survives a refresh. The cart is saved (debounced) while it is live and put
 * back UNLOCKED with a banner on the next visit. A held attempt always wins: when one is stored the sale it describes is the
 * truth (and may already be written), so nothing is restored over it. While a sale is going out, showing a receipt or held
 * as unknown (`suspended`) the stored cart is dropped, so a refresh can never ring the same cart twice.
 */
export function useCounterLiveCart({
  storeKey,
  heldKey,
  snapshot,
  suspended,
  canRestore,
  onRestore,
}: {
  storeKey: string | null;
  heldKey: string | null;
  snapshot: LiveCartSnapshot;
  suspended: boolean;
  canRestore: boolean;
  onRestore: (snap: LiveCartSnapshot) => void;
}): { restored: boolean; dismissRestored: () => void } {
  const [restored, setRestored] = React.useState(false);
  const [hydrated, setHydrated] = React.useState(false);
  const hydratedKeyRef = React.useRef<string | null>(null);
  const onRestoreRef = React.useRef(onRestore);
  onRestoreRef.current = onRestore;

  React.useEffect(() => {
    if (!storeKey || hydratedKeyRef.current === storeKey) return;
    hydratedKeyRef.current = storeKey;
    if (readHeldAttempt(heldKey) !== null) {
      clearLiveCart(storeKey); // the held sale is the truth
    } else if (canRestore) {
      const snap = readLiveCart(storeKey);
      if (snap) {
        onRestoreRef.current(snap);
        setRestored(true);
      }
    }
    setHydrated(true);
  }, [storeKey, heldKey, canRestore]);

  const latest = React.useRef(snapshot);
  latest.current = snapshot;
  const { lines, customer, method, tendered, reference } = snapshot;
  React.useEffect(() => {
    if (!storeKey || !hydrated) return;
    if (suspended) {
      clearLiveCart(storeKey);
      return;
    }
    const t = window.setTimeout(() => writeLiveCart(storeKey, latest.current), SAVE_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [storeKey, hydrated, suspended, lines, customer, method, tendered, reference]);

  // A refresh inside the debounce window still keeps the last edit.
  React.useEffect(() => {
    if (!storeKey || !hydrated || suspended) return;
    const flush = () => writeLiveCart(storeKey, latest.current);
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, [storeKey, hydrated, suspended]);

  return { restored, dismissRestored: () => setRestored(false) };
}
