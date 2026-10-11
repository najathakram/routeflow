/**
 * Row 317b: the ONE text of a receipt line's detail, shared by the live counter receipt, the Today's-sales reprint (apps/web)
 * and the emailed receipt (apps/api), so "3 × $2.50 each" reads the same on every surface. A plain line prints its quantity,
 * its price and the product's own selling unit; a boxed line prints boxes + pieces at the BOX price.
 */

/** Sign first: a downward reprice reads "-$1.00", never "$-1.00". */
export const formatReceiptMoney = (n: number): string =>
  `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;

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
    const word = (l.unit ?? "").trim() ? ` ${priceUnitWord(l.unit)}` : "";
    return `${l.qty} × ${price}${word}`;
  }
  const boxes = l.boxes ?? 0;
  const pieces = l.pieces ?? 0;
  const parts = [`${boxes} box${boxes === 1 ? "" : "es"}`];
  if (pieces) parts.push(`${pieces} pcs`);
  return `${parts.join(" + ")} × ${price} per box`;
}
