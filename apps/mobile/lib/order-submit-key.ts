/**
 * Client-generated Idempotency-Key for POST /orders (F30 · R8, REG-B196).
 *
 * One key PER CUSTOMER cart session (B215/R3): minted lazily on first read for that customer and
 * reused across every retry/replay of the SAME cart (a tapped-twice submit, a timed-out request
 * the operator retries, an offline-queue replay) so the server's tenant-scoped unique constraint
 * on `Order.idempotencyKey` can collapse duplicates into a single order — replay returns the
 * original order instead of creating a sibling (apps/api/src/orders). This converts the queue's
 * at-least-once replay semantics into effectively-once, closing B196's duplicate-order leg even
 * when a queue bug re-sends the same cart twice.
 *
 * Keys are held in a `customerId -> key` map rather than one module singleton, because the
 * server's replay identity is CUSTOMER-SCOPED: carrying one customer's key onto another's cart
 * makes the submit look like a replay of an order that is not theirs and the API refuses it
 * outright (409 `IDEMPOTENCY_KEY_CONFLICT` / `HELD_BY_OTHER_ORDER`). A map needs no rotation on
 * "Change customer" at all — each customer simply reads their own slot — and, unlike a rotating
 * singleton, it survives the round trip A -> B -> A: the still-live cart for A keeps the key its
 * own in-flight retry must send, instead of minting a sibling duplicate order.
 *
 * A customer's key is cleared — so their NEXT cart mints a fresh one — ONLY on:
 *   1. a successful submit for that customer (the cart that owned the key is now a real order;
 *      any further submit is deliberately a NEW order and must get its own key)
 *   2. an explicit cart clear (`clearAllOrderSubmitKeys()` — the operator abandons the cart on
 *      purpose, so no customer's slot is still live)
 *   3. the 409 "Open order" wind-down for that customer (the key is already spoken for; the cart
 *      that owned it is finished with)
 *
 * A failed submit (timeout, 4xx, network drop) must NOT clear that customer's key — that cart is
 * still live, and a retry/replay needs the SAME key so server-side idempotency can catch it
 * instead of minting a sibling duplicate order.
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

/** `customerId -> that customer's live cart-session key`. */
const keysByCustomer = new Map<string, string>();

/**
 * The slot a null/undefined customerId uses. A cart with no customer resolved yet still needs a
 * stable key (the screen can submit as soon as one is picked), and it must not be confused with
 * any real customer id — customer ids are UUIDs, so no collision is possible.
 */
const NO_CUSTOMER = "__none__";

function slot(customerId: string | null | undefined): string {
  return customerId ?? NO_CUSTOMER;
}

/**
 * Return this customer's cart-session Idempotency-Key, minting one on first call for them.
 * Every submit/retry/replay of the SAME cart must send this exact value on the
 * `Idempotency-Key` header of POST /orders.
 */
export function getOrderSubmitKey(customerId: string | null | undefined): string {
  const id = slot(customerId);
  let key = keysByCustomer.get(id);
  if (!key) {
    key = mintCartSessionKey();
    keysByCustomer.set(id, key);
  }
  return key;
}

/**
 * Start a fresh cart session FOR ONE CUSTOMER: their next `getOrderSubmitKey()` call mints a new
 * key, and every other customer's key is untouched. Call this ONLY after a submit for that
 * customer actually succeeds, or on the 409 "Open order" wind-down — never on failure or timeout,
 * or a retry of the same cart would mint a sibling key and defeat server-side idempotency.
 */
export function resetOrderSubmitKey(customerId: string | null | undefined): void {
  keysByCustomer.delete(slot(customerId));
}

/**
 * Drop EVERY customer's key — the explicit cart-clear path, where the operator abandons the cart
 * on purpose and no slot is still live. Never call this on a submit failure.
 */
export function clearAllOrderSubmitKeys(): void {
  keysByCustomer.clear();
}
