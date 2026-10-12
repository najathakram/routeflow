/**
 * Row 317b: the ONE text of a receipt line's detail, shared by the live counter receipt, the Today's-sales reprint (apps/web)
 * and the emailed receipt (apps/api), so "3 × $2.50 each" reads the same on every surface. A plain line prints its quantity,
 * its price and the product's own selling unit; a boxed line prints boxes + pieces at the BOX price.
 */

const RECEIPT_MONEY = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * The ONE money text of a receipt, the Today's-sales list and the Z report, web and emailed alike: US grouping to two
 * places, "$2,097.00" like the Orders list (CQ-19). Sign first: a downward reprice reads "-$1.00", never "$-1.00".
 */
export const formatReceiptMoney = (n: number): string =>
  `${n < 0 ? "-" : ""}$${RECEIPT_MONEY.format(Math.abs(n))}`;

/** The word a price is quoted per: the unit the operator chose (lower-cased), else "unit". */
export function priceUnitWord(unit: string | null | undefined): string {
  const t = (unit ?? "").trim().toLowerCase();
  return t || "unit";
}

export function receiptLineDetail(l: {
  /** the net unit price (a boxed line's is the BOX price) */
  unitPrice: number;
  qty: number;
  unitsPerBox?: number | null;
  boxes?: number | null;
  pieces?: number | null;
  /** the product's own selling unit ("each", "lb"); printed after the price of a plain line. Absent/blank: no word. */
  unit?: string | null;
}): string {
  const price = formatReceiptMoney(l.unitPrice);
  if ((l.unitsPerBox ?? 0) <= 1) {
    // "1 × $1.75 each": the unit follows the price in a sentence, never as "/ each"; another unit reads "per lb" like "per box"
    const unit = (l.unit ?? "").trim() ? priceUnitWord(l.unit) : "";
    const word = unit ? (unit === "each" ? " each" : ` per ${unit}`) : "";
    return `${l.qty} × ${price}${word}`;
  }
  const boxes = l.boxes ?? 0;
  const pieces = l.pieces ?? 0;
  const parts = [`${boxes} box${boxes === 1 ? "" : "es"}`];
  if (pieces) parts.push(`${pieces} pcs`);
  return `${parts.join(" + ")} × ${price} per box`;
}
