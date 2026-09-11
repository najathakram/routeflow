/**
 * Client-generated Idempotency-Key for POST /orders (F30 · R8, REG-B196).
 *
 * One key per "cart session": minted lazily on first read and reused across
 * every retry/replay of the SAME cart (a tapped-twice submit, a timed-out
 * request the operator retries, an offline-queue replay) so the server's
 * tenant-scoped unique constraint on `Order.idempotencyKey` can collapse
 * duplicates into a single order — replay returns the original order instead
 * of creating a sibling (apps/api/src/orders). This converts the queue's
 * at-least-once replay semantics into effectively-once, closing B196's
 * duplicate-order leg even when a queue bug re-sends the same cart twice.
 *
 * The key resets — so the NEXT cart mints a fresh key — ONLY on:
 *   1. a successful submit (the cart that owned the key is now a real order;
 *      any further submit is deliberately a NEW order and must get its own key)
 *   2. an explicit cart clear (the operator abandons the draft/cart on purpose)
 *   3. a CUSTOMER SWITCH (B215): "Change customer" in NewOrderScreen, when the newly
 *      picked customer differs from the one this key was minted for. The server's replay
 *      identity is customer-scoped, so carrying one customer's key onto another's cart
 *      makes the submit look like a replay of an order that is not theirs — the API
 *      refuses it (409 `IDEMPOTENCY_KEY_CONFLICT` / `HELD_BY_OTHER_ORDER`) and the
 *      screen wedges. Re-picking the SAME customer is not a switch and keeps the key.
 *
 * A failed submit (timeout, 4xx, network drop) must NOT reset the key — that
 * cart is still live, and a retry/replay needs the SAME key so server-side
 * idempotency can catch it instead of minting a sibling duplicate order.
 *
 * Pure module, no RN dependency — importable from screens (NewOrderScreen's
 * wedge/submit wiring) and from lib/api-client.ts alike.
 */

/**
 * A v4-shaped UUID built from `Math.random`. This value only needs to be
 * unique per cart session — it is never used for cryptographic purposes — so
 * `Math.random` keeps this module dependency-free (no `uuid` package, no
 * `expo-crypto`) and usable as-is under plain Node in Jest.
 */
function mintCartSessionKey(): string {
  const bytes: number[] = [];
  for (let i = 0; i < 16; i++) {
    bytes.push(Math.floor(Math.random() * 256));
  }
  // Stamp the version (4) and variant (10) nibbles per RFC 4122 §4.4.
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = bytes.map((b) => b.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
}

let currentKey: string | null = null;

/**
 * Return this cart session's Idempotency-Key, minting one on first call.
 * Every submit/retry/replay of the SAME cart must send this exact value on
 * the `Idempotency-Key` header of POST /orders.
 */
export function getOrderSubmitKey(): string {
  if (!currentKey) {
    currentKey = mintCartSessionKey();
  }
  return currentKey;
}

/**
 * Start a fresh cart session: the next `getOrderSubmitKey()` call mints a new
 * key. Call this ONLY after a submit actually succeeds, or when the operator
 * explicitly clears/abandons the cart — never on failure or timeout, or a
 * retry of the same cart would mint a sibling key and defeat server-side
 * idempotency.
 */
export function resetOrderSubmitKey(): void {
  currentKey = null;
}
