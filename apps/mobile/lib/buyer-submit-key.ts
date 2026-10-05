/**
 * B1094: the `Idempotency-Key` for `POST /buyer/orders`. A double submit (a double tap, a retry of a
 * request that timed out after the server applied it) must send the SAME key so the server applies the
 * cart once. The key follows the CART, not the call: the same payload reuses its key until a submit
 * succeeds; an edited cart is a different cart and mints a new one (reusing the old key on it would be
 * refused by the server as a different cart under a used key). Pure module — no RN dependency, no
 * storage, usable from plain-Node Jest.
 */
let current: { fingerprint: string; key: string } | null = null;

/** A v4-shaped UUID from `Math.random`: only needs to be unique per cart, never secret. */
function mintKey(): string {
  const b: number[] = [];
  for (let i = 0; i < 16; i++) b.push(Math.floor(Math.random() * 256));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.map((x) => x.toString(16).padStart(2, "0"));
  return [h.slice(0, 4), h.slice(4, 6), h.slice(6, 8), h.slice(8, 10), h.slice(10, 16)]
    .map((p) => p.join(""))
    .join("-");
}

/** The key for this cart: the in-flight one when the payload is unchanged, else a fresh one. */
export function buyerSubmitKeyFor(payload: unknown): string {
  const fingerprint = JSON.stringify(payload);
  if (!current || current.fingerprint !== fingerprint) current = { fingerprint, key: mintKey() };
  return current.key;
}

/** A submit landed: the cart is now an order, so the next submit is a new cart with its own key. */
export function clearBuyerSubmitKey(): void {
  current = null;
}
