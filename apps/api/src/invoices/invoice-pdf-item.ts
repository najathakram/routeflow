/**
 * Per-line promo/original-price display decisions for the invoice PDF (F03 R9).
 *
 * WHY a helper rather than assertions on the template: `./invoice-pdf-template` is
 * replaced wholesale by `apps/api/test/__mocks__/invoice-pdf-template.js` through
 * apps/api/package.json's `jest.moduleNameMapper`, so the real `.tsx` renderer never
 * executes under Jest and no in-template assertion is available. Extracting the two
 * decisions the requirement is actually about makes them unit-testable.
 *
 * The visual reference is the web invoice detail renderer,
 * `apps/web/app/(dashboard)/invoices/[id]/page.tsx` :2408-2481.
 */

export type InvoicePdfItemLike = {
  qty?: number | string | null;
  unitPrice?: number | string | null;
  originalPrice?: number | string | null;
  priceType?: string | null;
  promoFreeUnits?: number | string | null;
};

/**
 * The BUY_N_GET_M note shown under the line description — `"<N> free"`, matching the
 * web renderer's wording — or `null` when the line has no free units (without it a
 * BOGO line's reduced subtotal reads as a pricing error).
 */
export function promoNote(item: InvoicePdfItemLike): string | null {
  const freeUnits = item.promoFreeUnits != null ? Number(item.promoFreeUnits) : 0;
  return freeUnits > 0 ? `${freeUnits} free` : null;
}

/**
 * Whether the struck-through pre-promo `originalPrice` renders beside the charged
 * unit price. False when the tenant hid original prices, when there is no original
 * price to show, and for a MANUAL upsell (unitPrice ABOVE originalPrice) — the web
 * renderer deliberately never shows the lower base price to the buyer there. Mirrors
 * the web renderer's SPECIAL/DISCOUNTED/PROMO/adjusted-MANUAL branches, which all
 * strike the original price whenever one is set and the tenant hasn't hidden it.
 */
export function showOriginalPrice(item: InvoicePdfItemLike, hideOriginalPrice: boolean): boolean {
  if (hideOriginalPrice) return false;
  if (item.originalPrice == null) return false;
  const original = Number(item.originalPrice);
  const unitPrice = item.unitPrice != null ? Number(item.unitPrice) : 0;
  // MANUAL upsell (charged ABOVE the base price): never expose the lower base.
  if (item.priceType === "MANUAL" && unitPrice > original) return false;
  return true;
}
