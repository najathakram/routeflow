/**
 * The ONE rule for whether a line's struck-through `originalPrice` may show beside the charged unit price. It started life
 * in the invoice PDF's helper (`invoice-pdf-item.ts`, F03 R9) and is shared from here so the invoice PDF, the invoice email
 * and every receipt (the live counter receipt, the Today's-sales reprint, the emailed receipt) read the SAME decision.
 *
 * False when the tenant hid original prices (`invoice.hideOriginalPrice`), when there is no original price to show, and for
 * any line charged ABOVE its originalPrice (`isAboveListLine`: a MANUAL upsell or a tier above Retail): the lower base is
 * never exposed to the buyer there. Otherwise (a saving on SPECIAL, DISCOUNTED, PROMO or an adjusted MANUAL) the original is
 * struck whenever one is stored. The base is the stored `originalPrice` (the LIST price), never a tier price.
 */
import { isAboveListLine } from "./pricing";

export type OriginalPriceItem = {
  unitPrice?: number | string | null;
  originalPrice?: number | string | null;
  priceType?: string | null;
};

export function showOriginalPrice(item: OriginalPriceItem, hideOriginalPrice: boolean): boolean {
  if (hideOriginalPrice) return false;
  if (item.originalPrice == null) return false;
  // Charged ABOVE the base price: never expose the lower base.
  return !isAboveListLine(item);
}
