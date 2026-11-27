import { farFromListReference } from "@/lib/far-from-list";
import type { EditItemState } from "./order-line-edit";

/**
 * What the order page's "far from list" note compares a line's price with (B1423, ruling SA-1405): the line's catalog
 * list price in its sold unit (`listReference`), or null when the note must stay silent.
 *
 * The system set the price, so nothing is said until someone types one, when the line is: new on this page (it starts
 * on the customer's tier, history or contract price), a contract (SPECIAL) or promo line, or a line whose price moved
 * this session without typing (a unit pick, a substitute). A saved line a person priced (MANUAL, DISCOUNTED) keeps its
 * note when edit opens: that price was typed once and is still far off.
 */
export function lineFarFromListReference(
  it: Pick<
    EditItemState,
    "listReference" | "priceEdited" | "isNew" | "priceType" | "unitPrice" | "originalUnitPrice"
  >,
): number | null {
  const movedUntyped = Math.abs(it.unitPrice - (it.originalUnitPrice ?? it.unitPrice)) > 0.0001;
  const systemSet =
    it.isNew === true || it.priceType === "SPECIAL" || it.priceType === "PROMO" || movedUntyped;
  return farFromListReference(it.listReference, systemSet, it.priceEdited === true);
}
