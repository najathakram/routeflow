import { unitNameKey, withinStaffOverrideTolerance } from "@routeflow/pricing";
import { cartMismatchConflict } from "../merge-idempotency";
import type { ReplayedCart, ReplayedOrder } from "../order-create-options";

/**
 * POS-5: create()'s replay compare is product x qty only, so a counter request re-sent under the same
 * Idempotency-Key with a DIFFERENT price would silently get the original sale back. This is the counter's own
 * price half of that compare, run from `onReplay` (after the cart compare passed, before any write).
 *
 * A request line with a `unitPrice` must match a stored line of the same product priced within 1/2 cent of it
 * (a typed price equal to the tier price is stored as a plain line at that price, and 3.335 is stored as 3.34);
 * a request line WITHOUT one must match a stored line that carries no staff override (`overriddenBy` unset).
 * SA-1040 B4a: a product can sit on two lines (a Case and its pack), so a request line also matches the stored line's
 * UNIT (`unitNameKey(unitLabel ?? "")`); a pack line's key is "". SA-1047: the request lines are the CART create()'s
 * replay compare judged (`onReplay`'s second argument: a unit line that resolves to the pack, such as the pack's own
 * label, arrives with `unitLabel` null, as stored). Handing it the raw request would 409 a replay the cart compare passed.
 * Until SA-1047 this check is the only place a replay told units apart; `replayLineKey` now does too, on the same cart.
 * No match for any line = the same coded 409 as any other changed cart (IDEMPOTENCY_KEY_CART_MISMATCH).
 * An order that carries no line detail is not judged.
 */
export function assertReplaySamePrices(
  existing: ReplayedOrder,
  items: NonNullable<ReplayedCart>,
): void {
  if (!existing.lineItems) return;
  const free = existing.lineItems.filter((l) => l.status !== "CANCELLED");
  for (const item of items) {
    const at = free.findIndex(
      (l) =>
        (l.productId ?? null) === item.productId &&
        unitNameKey(l.unitLabel ?? "") === unitNameKey(item.unitLabel ?? "") &&
        (item.unitPrice != null
          ? withinStaffOverrideTolerance(item.unitPrice, Number(l.unitPrice))
          : !l.overriddenBy),
    );
    if (at < 0) throw cartMismatchConflict(existing.id);
    free.splice(at, 1);
  }
}
