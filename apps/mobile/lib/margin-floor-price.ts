import { classifyMargin, computeMarginFraction, priceForMarginFloor } from "@routeflow/pricing";
import { toNumber } from "./cart-line-state";
import type { DraftItem } from "./edit-items-draft";

/**
 * B263 (review round) — the ONE margin-floor derivation both price-edit
 * surfaces read: the list row's below-floor guard and the picker's
 * last-added strip. Same helper, same arguments (`averageCost` per piece,
 * the line's category floor, `unitsPerBox`), so a price the row flags is
 * flagged identically on the scan surface. Null when the product has no
 * known cost — no cost, no floor, no ack.
 *
 * Moved out of edit-items.tsx unchanged (#2232 prefactor, size ratchet).
 */
export function marginFloorPrice(
  item: Pick<DraftItem, "averageCost" | "unitPrice" | "unitsPerBox">,
  marginFloor: number,
): number | null {
  const pieceCost = item.averageCost != null ? toNumber(item.averageCost) : null;
  if (pieceCost == null || !Number.isFinite(pieceCost)) return null;
  const marginFrac = computeMarginFraction(item.unitPrice, pieceCost, item.unitsPerBox);
  if (classifyMargin(marginFrac, marginFloor) == null) return null;
  return priceForMarginFloor(pieceCost, marginFloor, item.unitsPerBox);
}
