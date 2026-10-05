/**
 * B1094: the `Idempotency-Key` for `POST /buyer/orders`. A double submit (a double click, a retry of a
 * request that timed out after the server applied it) must send the SAME key so the server applies the
 * cart once. The key follows the CART, not the call: the same payload reuses its key until a submit
 * succeeds; an edited cart is a different cart and mints a new one (reusing the old key on it would be
 * refused by the server as a different cart under a used key). Pure module — no React, no storage.
 */
let current: { fingerprint: string; key: string } | null = null;

function mintKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

/**
 * The key for this cart: the in-flight one when the payload is unchanged, else a fresh one. `scope`
 * is WHO is submitting (buyer account + active seller): the server's replay identity is
 * customer-scoped, so one customer's key must never ride onto another's cart (a different
 * scope is a different cart here, whatever the payload). `clearBuyerSubmitKey` also runs on
 * logout and on a seller switch.
 */
export function buyerSubmitKeyFor(payload: unknown, scope = ""): string {
  const fingerprint = JSON.stringify([scope, payload]);
  if (!current || current.fingerprint !== fingerprint) current = { fingerprint, key: mintKey() };
  return current.key;
}

/** A submit landed: the cart is now an order, so the next submit is a new cart with its own key. */
export function clearBuyerSubmitKey(): void {
  current = null;
}
