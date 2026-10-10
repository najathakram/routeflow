import { withinStaffOverrideTolerance } from "@routeflow/pricing";
import { cartMismatchConflict } from "../merge-idempotency";
import type { ReplayedOrder } from "../order-create-options";
import type { CounterSaleDto } from "./counter-sale.dto";

/**
 * POS-5: create()'s replay compare is product x qty only, so a counter request re-sent under the same
 * Idempotency-Key with a DIFFERENT price would silently get the original sale back. This is the counter's own
 * price half of that compare, run from `onReplay` (after the cart compare passed, before any write).
 *
 * A request line with a `unitPrice` must match a stored line of the same product priced within 1/2 cent of it
 * (a typed price equal to the tier price is stored as a plain line at that price, and 3.335 is stored as 3.34);
 * a request line WITHOUT one must match a stored line that carries no staff override (`overriddenBy` unset).
 * No match for any line = the same coded 409 as any other changed cart (IDEMPOTENCY_KEY_CART_MISMATCH).
 * An order that carries no line detail is not judged.
 */
export function assertReplaySamePrices(
  existing: ReplayedOrder,
  items: CounterSaleDto["items"],
): void {
  if (!existing.lineItems) return;
  const free = existing.lineItems.filter((l) => l.status !== "CANCELLED");
  for (const item of items) {
    const at = free.findIndex(
      (l) =>
        (l.productId ?? null) === item.productId &&
        (item.unitPrice != null
          ? withinStaffOverrideTolerance(item.unitPrice, Number(l.unitPrice))
          : !l.overriddenBy),
    );
    if (at < 0) throw cartMismatchConflict(existing.id);
    free.splice(at, 1);
  }
}
