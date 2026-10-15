/**
 * The ONE rule for whether a line's struck-through `originalPrice` may show beside the charged unit price. It started life
 * in the invoice PDF's helper (`invoice-pdf-item.ts`, F03 R9) and is shared from here so the invoice PDF, the invoice email
 * and every receipt (the live counter receipt, the Today's-sales reprint, the emailed receipt) read the SAME decision.
 *
 * False when the tenant hid original prices (`invoice.hideOriginalPrice`), when there is no original price to show, and for
 * a MANUAL upsell (unitPrice ABOVE originalPrice): the lower base is never exposed to the buyer there. Otherwise (SPECIAL,
 * DISCOUNTED, PROMO, an adjusted MANUAL) the original is struck whenever one is stored. The base is the stored
 * `originalPrice` (the LIST price), never a tier price.
 */
export type OriginalPriceItem = {
  unitPrice?: number | string | null;
  originalPrice?: number | string | null;
  priceType?: string | null;
};

export function showOriginalPrice(item: OriginalPriceItem, hideOriginalPrice: boolean): boolean {
  if (hideOriginalPrice) return false;
  if (item.originalPrice == null) return false;
  const original = Number(item.originalPrice);
  const unitPrice = item.unitPrice != null ? Number(item.unitPrice) : 0;
  // MANUAL upsell (charged ABOVE the base price): never expose the lower base.
  if (item.priceType === "MANUAL" && unitPrice > original) return false;
  return true;
}
