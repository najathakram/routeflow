import * as React from "react";
import { readHeldAttempt } from "@/lib/counter-sale";
import {
  clearLiveCart,
  readLiveCart,
  writeLiveCart,
  type LiveCartSnapshot,
} from "@/lib/counter-live-cart";

const SAVE_DELAY_MS = 400;
const TAB_ID_KEY = "rf.counterSale.tabId";

/** A per-tab id (sessionStorage survives a refresh, not a new tab): who last wrote the stored cart. */
function tabId(): string {
  try {
    const have = window.sessionStorage.getItem(TAB_ID_KEY);
    if (have) return have;
    const fresh = globalThis.crypto?.randomUUID?.() ?? `tab-${Math.random().toString(36).slice(2)}`;
    window.sessionStorage.setItem(TAB_ID_KEY, fresh);
    return fresh;
  } catch {
    return "tab-unknown";
  }
}

/**
 * Is this tab the till's only live tab? A Web Lock held for the tab's lifetime says so: it frees itself when the tab closes
 * or crashes, and unlike a heartbeat a throttled background tab cannot lose it. Without Web Locks the stored writer id
 * decides: only the tab that wrote the cart (a refresh keeps its id) takes it back. Known gap of that fallback: a DUPLICATED
 * tab copies sessionStorage and so shares the id. Dev-only note: React StrictMode's double effect run never takes ownership
 * locally (the first run's cleanup cancels its claim); production mounts once.
 */
async function claimTill(storeKey: string, storedOwner: string | undefined): Promise<boolean> {
  const locks = (globalThis.navigator as Navigator & { locks?: LockManager }).locks;
  if (!locks?.request) return storedOwner === undefined || storedOwner === tabId();
  return new Promise<boolean>((resolve) => {
    void locks
      .request(`rf-counter-cart:${storeKey}`, { ifAvailable: true }, (lock) => {
        resolve(lock !== null);
        return lock ? new Promise<never>(() => undefined) : undefined; // held until the tab goes away
      })
      .catch(() => resolve(false));
  });
}

export type LiveCartNotice = "restored" | "other-tab" | "cleared-elsewhere" | null;

/**
 * SA-748 section 1: the unfinished counter sale survives a refresh. The cart is saved (debounced) while it is live and put
 * back UNLOCKED with a banner on the next visit. Money rules, every one of them to stop a cart being rung twice:
 *  - a held attempt always wins: the sale it describes is the truth (and may already be written);
 *  - while a sale is going out, showing a receipt or held as unknown the stored cart is dropped, and `beginSend()` drops it
 *    SYNCHRONOUSLY, before the POST leaves, and blocks every later write until `endSend()`;
 *  - only the till's single live tab restores or writes the stored cart (a second tab is told, and left alone);
 *  - a restored cart nobody touched is dropped when another tab clears the stored one.
 */
export function useCounterLiveCart({
  storeKey,
  heldKey,
  snapshot,
  suspended,
  canRestore,
  onRestore,
  onClearedElsewhere,
}: {
  storeKey: string | null;
  heldKey: string | null;
  snapshot: LiveCartSnapshot;
  suspended: boolean;
  canRestore: boolean;
  onRestore: (snap: LiveCartSnapshot) => void;
  onClearedElsewhere: () => void;
}): {
  notice: LiveCartNotice;
  dismissNotice: () => void;
  beginSend: () => void;
  endSend: () => void;
} {
  const [notice, setNotice] = React.useState<LiveCartNotice>(null);
  const [owner, setOwner] = React.useState(false); // this tab may write the stored cart
  const [sending, setSending] = React.useState(false);
  const sendingRef = React.useRef(false);
  const ownerRef = React.useRef(false); // mirrors `owner` for the synchronous send guard
  const hydratedKeyRef = React.useRef<string | null>(null);
  const restoredLinesRef = React.useRef<unknown[] | null>(null);
  const onRestoreRef = React.useRef(onRestore);
  onRestoreRef.current = onRestore;
  const onClearedRef = React.useRef(onClearedElsewhere);
  onClearedRef.current = onClearedElsewhere;
  const latest = React.useRef(snapshot);
  latest.current = snapshot;
  const me = tabId;

  React.useEffect(() => {
    if (!storeKey || hydratedKeyRef.current === storeKey) return;
    hydratedKeyRef.current = storeKey;
    let alive = true;
    const stored = readLiveCartRaw(storeKey);
    void claimTill(storeKey, stored?.owner).then((isOwner) => {
      if (!alive) return;
      if (!isOwner) {
        // Another live tab has the till: restore nothing, touch nothing, say so.
        if (stored) setNotice("other-tab");
        return;
      }
      if (readHeldAttempt(heldKey) !== null) {
        clearLiveCart(storeKey); // the held sale is the truth
      } else if (canRestoreRef.current) {
        const snap = readLiveCart(storeKey);
        if (snap) {
          restoredLinesRef.current = snap.lines;
          onRestoreRef.current(snap);
          setNotice("restored");
        }
      }
      ownerRef.current = true;
      setOwner(true);
    });
    return () => {
      alive = false;
    };
  }, [storeKey, heldKey]);
  const canRestoreRef = React.useRef(canRestore);
  canRestoreRef.current = canRestore;

  const { lines, customer, method, tendered, reference } = snapshot;
  React.useEffect(() => {
    if (!storeKey || !owner) return;
    if (suspended || sending) {
      clearLiveCart(storeKey);
      return;
    }
    const t = window.setTimeout(() => {
      if (!sendingRef.current) writeLiveCart(storeKey, latest.current, me());
    }, SAVE_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [storeKey, owner, suspended, sending, lines, customer, method, tendered, reference]);

  // A refresh inside the debounce window still keeps the last edit, unless a sale is going out.
  React.useEffect(() => {
    if (!storeKey || !owner || suspended || sending) return;
    const flush = () => {
      if (!sendingRef.current) writeLiveCart(storeKey, latest.current, me());
    };
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, [storeKey, owner, suspended, sending]);

  // Another tab cleared the stored cart (sale finished, logout) while this tab still shows a restored cart it never touched.
  React.useEffect(() => {
    if (!storeKey || !owner) return;
    const onStorage = (e: StorageEvent) => {
      if (e.key !== storeKey || e.newValue !== null) return;
      if (restoredLinesRef.current && restoredLinesRef.current === latest.current.lines) {
        restoredLinesRef.current = null;
        onClearedRef.current();
        setNotice("cleared-elsewhere");
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [storeKey, owner]);

  return {
    notice,
    dismissNotice: () => setNotice(null),
    beginSend: () => {
      sendingRef.current = true; // blocks every write NOW, not on the next render
      // Only the owner tab drops the stored cart: a second tab's sale must never delete the owner's cart.
      if (storeKey && ownerRef.current) clearLiveCart(storeKey);
      setSending(true);
    },
    endSend: () => {
      sendingRef.current = false;
      setSending(false);
    },
  };
}

/** The stored writer id, read without validating the cart (only to decide who may take it back). */
function readLiveCartRaw(storeKey: string): { owner?: string } | null {
  try {
    const raw = window.localStorage.getItem(storeKey);
    return raw ? (JSON.parse(raw) as { owner?: string }) : null;
  } catch {
    return null;
  }
}
