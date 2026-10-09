import { validCustomer, validLine } from "./counter-sale";

/** Bump when the stored shape changes: a cart under any other version is dropped, never half-read. */
export const LIVE_CART_VERSION = 1;

/** What the till needs to put an unfinished sale back: the cart, the customer and the payment fields. */
export interface LiveCartSnapshot {
  lines: unknown[];
  customer: unknown;
  method: string;
  tendered: string;
  reference: string;
}

export function writeLiveCart(
  storeKey: string | null,
  snap: LiveCartSnapshot,
  owner: string,
): void {
  if (!storeKey) return;
  try {
    if (snap.lines.length === 0) {
      window.localStorage.removeItem(storeKey);
      return;
    }
    // Only what the till re-renders: never the customer's email, phone, address or any other field.
    const c = snap.customer as Record<string, unknown> | null | undefined;
    const customer = c
      ? Object.fromEntries(
          (["id", "businessName", "pricingTier", "fulfillPath"] as const)
            .filter((k) => c[k] !== undefined)
            .map((k) => [k, c[k]]),
        )
      : null;
    window.localStorage.setItem(
      storeKey,
      JSON.stringify({ v: LIVE_CART_VERSION, owner, ...snap, customer }),
    );
  } catch {
    /* storage unavailable or full: the cart is still on screen */
  }
}

/** The stored cart, or null when none / unreadable (an unreadable one is dropped; it can never lock the till). */
export function readLiveCart(storeKey: string | null): LiveCartSnapshot | null {
  if (!storeKey) return null;
  try {
    const raw = window.localStorage.getItem(storeKey);
    if (!raw) return null;
    const v = JSON.parse(raw) as (Partial<LiveCartSnapshot> & { v?: number }) | null;
    const ok =
      !!v &&
      v.v === LIVE_CART_VERSION &&
      Array.isArray(v.lines) &&
      v.lines.length > 0 &&
      v.lines.every(validLine) &&
      typeof v.method === "string" &&
      validCustomer(v.customer);
    if (ok) {
      return {
        lines: v!.lines!,
        customer: v!.customer ?? null,
        method: v!.method!,
        tendered: typeof v!.tendered === "string" ? v!.tendered : "",
        reference: typeof v!.reference === "string" ? v!.reference : "",
      };
    }
    window.localStorage.removeItem(storeKey);
  } catch {
    try {
      window.localStorage.removeItem(storeKey);
    } catch {
      /* nothing to drop */
    }
  }
  return null;
}

export function clearLiveCart(storeKey: string | null): void {
  if (!storeKey) return;
  try {
    window.localStorage.removeItem(storeKey);
  } catch {
    /* nothing to clear */
  }
}
