import { computeLineSubtotal, roundMoney } from "./pricing";
import { showOriginalPrice } from "./show-original-price";

/**
 * SA-762r / SA-751r: the ONE rule for how a receipt line shows a lowered price. The live counter receipt, the Today's-sales
 * reprint and the emailed receipt all build their lines here, and the question "may the list price show at all?" is the
 * invoices' own (`showOriginalPrice`: the tenant's `invoice.hideOriginalPrice`, a stored `originalPrice` that is the LIST
 * price, and no exposure of a MANUAL upsell's lower base). So the same sale can never read "Subtotal $32.48, Discounts
 * -$9.98, $29.98 struck" on one surface and "Subtotal $22.50" on another.
 *
 * `total` is the NET line total (what was charged). `original` is the line at its list price, struck on the receipt, and
 * `discount` the money taken off it: both only when the invoice rule shows the list price AND the price was LOWERED. A
 * raised or equal list price prints plain: a customer never sees a list price below what they were charged.
 */
export function receiptLineAmounts(input: {
  /** the net unit price (a boxed line's is the BOX price) */
  unitPrice: number;
  /** the stored list price (`OrderItem.originalPrice` / `InvoiceItem.originalPrice`); null = never lowered */
  originalPrice?: number | string | null;
  /** the stored price type (STANDARD, SPECIAL, DISCOUNTED, MANUAL, PROMO): a MANUAL upsell never shows its base */
  priceType?: string | null;
  /** the tenant's `invoice.hideOriginalPrice`: no struck price and no discount at all */
  hideOriginalPrice?: boolean;
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
  const shows = showOriginalPrice(
    {
      unitPrice: input.unitPrice,
      originalPrice: input.originalPrice,
      priceType: input.priceType,
    },
    !!input.hideOriginalPrice,
  );
  if (!shows) return { total, original: null, discount: 0 };
  const listTotal = amounts(Number(input.originalPrice));
  const discount = roundMoney(listTotal - total);
  return discount > 0
    ? { total, original: listTotal, discount }
    : { total, original: null, discount: 0 };
}
