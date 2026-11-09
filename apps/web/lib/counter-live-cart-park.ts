/**
 * W-1184: signing out must not lose an unfinished counter sale. Before the browser forgets the stored live carts, each one
 * is parked on the server for the signed-in user (the same park the Park button uses), so it comes back under Parked on any
 * device. Best effort: a refused or offline park never blocks the sign-out.
 */
import { apiClient } from "./api-client";
import { readLiveCart } from "./counter-live-cart";
import { LIVE_CART_KEY } from "./counter-live-cart-keys";
import { newIdempotencyKey } from "./counter-sale";
import { buildParkPayload } from "./counter-park";

const PARK_URL = "/orders/counter-sale/parked";

export async function parkStoredLiveCarts(): Promise<void> {
  if (typeof window === "undefined") return;
  const keys: string[] = [];
  try {
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith(`${LIVE_CART_KEY}:`)) keys.push(k);
    }
  } catch {
    return;
  }
  for (const key of keys) {
    const snap = readLiveCart(key);
    if (!snap || snap.lines.length === 0) continue;
    const built = buildParkPayload(snap);
    if (!built.ok) continue;
    try {
      await apiClient.post(PARK_URL, { id: newIdempotencyKey(), payload: built.value });
      window.localStorage.removeItem(key);
    } catch {
      /* the sale stays in this browser until the wipe: signing out is not blocked */
    }
  }
}
