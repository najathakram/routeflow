/**
 * W-1184: signing out must not lose an unfinished counter sale. Before the browser forgets the stored live cart, the signed-in
 * user's cart is parked on the server (the same park the Park button uses), so it comes back under Parked on any device.
 * Best effort: a refused or offline park never blocks the sign-out.
 */
import { apiClient } from "./api-client";
import { readLiveCart } from "./counter-live-cart";
import { newIdempotencyKey } from "./counter-sale";
import { buildParkPayload } from "./counter-park";

const PARK_URL = "/orders/counter-sale/parked";

export async function parkStoredLiveCarts(currentKey: string | null): Promise<void> {
  if (typeof window === "undefined" || !currentKey) return;
  // Only the signed-in user's cart: another user's stored cart is not this session's to park.
  const snap = readLiveCart(currentKey);
  if (!snap || snap.lines.length === 0) return;
  const built = buildParkPayload(snap);
  if (!built.ok) return;
  try {
    await apiClient.post(PARK_URL, { id: newIdempotencyKey(), payload: built.value });
    window.localStorage.removeItem(currentKey);
  } catch {
    /* the sale stays in this browser until the wipe: signing out is not blocked */
  }
}
