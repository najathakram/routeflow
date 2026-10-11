import { computeLineSubtotal, roundMoney } from "./pricing";

/**
 * SA-762r / SA-751r: the ONE rule for how a receipt line shows a lowered price. The live counter receipt (the cart's tier
 * price), the Today's-sales reprint and the emailed receipt (the order line's stored `originalPrice`) all build their lines
 * here, so the same sale can never read "Subtotal $32.48, Discounts -$9.98, $29.98 struck" on one surface and "Subtotal $22.50"
 * on another.
 *
 * `total` is the NET line total (what was charged). `original` is the line at its list price, struck on the receipt, and
 * `discount` the money taken off it: both only when the price was LOWERED. A raised or unchanged price prints plain: a
 * customer never sees a list price below what they were charged.
 */
export function receiptLineAmounts(input: {
  /** the net unit price (a boxed line's is the BOX price) */
  unitPrice: number;
  /** the list unit price the line was lowered from (the cart's tier price, or the stored `originalPrice`); null = none */
  listUnitPrice?: number | null;
  qty: number;
  boxes?: number | null;
  pieces?: number | null;
  unitsPerBox?: number | null;
}): { total: number; original: number | null; discount: number } {
  const amounts = (unitPrice: number) =>
    computeLineSubtotal({
      unitPrice,
      qty: input.qty,
      boxes: input.boxes,
      pieces: input.pieces,
      unitsPerBox: input.unitsPerBox,
    });
  const total = amounts(input.unitPrice);
  if (input.listUnitPrice == null) return { total, original: null, discount: 0 };
  const listTotal = amounts(input.listUnitPrice);
  const discount = roundMoney(listTotal - total);
  return discount > 0
    ? { total, original: listTotal, discount }
    : { total, original: null, discount: 0 };
}
