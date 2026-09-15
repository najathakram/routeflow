/**
 * Deterministic client-generated Idempotency-Key for POST /returns (returns-idem lane).
 *
 * `apps/api/src/returns/returns.service.ts#create` now honours an `Idempotency-Key` header,
 * collapsing a replayed submission onto the first result instead of minting a SECOND return —
 * and once approved a duplicate return is a double customer credit. That server guard does
 * nothing until a client actually sends the header, which is what this module supplies for the
 * driver return screen.
 *
 * DETERMINISTIC, NOT MINTED — and deliberately unlike `lib/order-submit-key.ts`:
 *
 * - `order-submit-key` mints a random uuid per cart SESSION and holds it in a module map,
 *   because a cart is a free-form, evolving thing with no stable identity of its own.
 * - A driver return has one: it is fully described by the stop being served, the order being
 *   returned against, and the goods going back. Deriving the key from those facts means a
 *   remount, an app kill, a reinstall, or a second device re-derive the SAME key with no state
 *   to persist and nothing to rotate, clear or leak across users. There is no module-level
 *   storage here on purpose.
 *
 * IDENTITY = stopId + orderId + the sorted `productId:qty` pairs + a per-attempt NONCE. Sorting
 * the pairs is what makes the key insensitive to the order `undeliveredReturnLines` happens to
 * emit rows in (it walks `deliveryMutations`, whose order is a server read detail, not a driver
 * decision). Per-row REASON is deliberately NOT part of the identity: the same goods going back
 * on the same stop are the same return whether or not the driver flipped the "Damaged" chip
 * before retrying.
 *
 * THE NONCE (F1, independent review, PR-2): stopId+orderId+goods alone is deterministic BY
 * DESIGN — see below — but that determinism silently collapsed a genuinely NEW later return for
 * identical goods into an earlier, already-landed one (the driver returns 2 units, then later
 * finds 2 more of the same product), under-crediting the customer. `caller` supplies a value from
 * `store/returnSubmissionStore.ts#getOrCreateNonce`, scoped per PENDING attempt: stable across
 * retries of ONE attempt (a network timeout, an offline-queue replay, an app kill mid-request all
 * reuse it, so those still collapse onto the same server-side return), cleared the moment that
 * attempt lands — so the caller's NEXT call for the same stop+order gets a fresh value and a
 * genuinely new return.
 *
 * The server hashes the header into `sha256(scope:key)` (`common/idempotency.service.ts`) under
 * scope `returns.create:<tenantId>:<orderId>`, so this value never needs to be short or opaque —
 * a readable canonical string beats a home-rolled hash here, because it cannot collide two
 * genuinely different returns into one lost credit. Its length is bounded by the returned line
 * count of a single order (tens of lines at worst — far inside any HTTP header limit).
 *
 * `lib/api-client.ts` copies the `idempotency-key` header onto a queued offline replay, so the
 * drain replay and a manual re-issue of the same goods both collapse to ONE server-side return.
 *
 * Pure module, no RN dependency — usable as-is under plain Node in Jest.
 */

/** The minimum a return payload has to expose to be identified. */
export interface ReturnSubmitKeyInput {
  orderId: string;
  items: ReadonlyArray<{ productId: string; qty: number }>;
}

/**
 * Header values must stay in the printable-ASCII range. Every real component is a UUID or a
 * number, so this never fires in practice — it is here so a surprising `productId` can never
 * produce an unsendable header (and the substitution is itself deterministic).
 */
function headerSafe(value: string): string {
  return value.replace(/[^A-Za-z0-9:,._-]/g, "_");
}

/**
 * The Idempotency-Key for ONE ATTEMPT at returning goods for one order at one stop. Every
 * submit/retry/offline-replay of the SAME attempt must pass the SAME `nonce` (from
 * `returnSubmissionStore#getOrCreateNonce`) to produce this exact value — that is what lets the
 * server collapse them into a single return. A genuinely new attempt (the nonce was cleared
 * because the prior one landed) produces a different value on purpose, even for identical goods.
 */
export function returnSubmitKey(
  stopId: string,
  payload: ReturnSubmitKeyInput,
  nonce: string,
): string {
  const pairs = payload.items
    .map((i) => `${i.productId}:${i.qty}`)
    .sort()
    .join(",");
  return headerSafe(`rtn:${stopId}:${payload.orderId}:${pairs}:${nonce}`);
}
