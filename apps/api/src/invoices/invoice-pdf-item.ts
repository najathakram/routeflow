/**
 * Per-line promo/original-price display decisions for the invoice PDF (F03 R9).
 *
 * ⚠️ CONTRACT STUB — signatures only, no behavior yet. The F03 build stage
 * (build-plan P3) implements both functions and calls them from
 * `invoice-pdf-template.tsx`; `invoice-pdf.service.spec.ts` is the contract.
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
 *
 * STUB: returns undefined, so both the "shows the note" and the "no note" assertions
 * are red.
 */
export function promoNote(_item: InvoicePdfItemLike): string | null {
  return undefined as unknown as string | null;
}

/**
 * Whether the struck-through pre-promo `originalPrice` renders beside the charged
 * unit price. False when the tenant hid original prices, when there is no original
 * price to show, and for a MANUAL upsell (unitPrice ABOVE originalPrice) — the web
 * renderer deliberately never shows the lower base price to the buyer there.
 *
 * STUB: returns undefined, so both the true and the false assertions are red.
 */
export function showOriginalPrice(_item: InvoicePdfItemLike, _hideOriginalPrice: boolean): boolean {
  return undefined as unknown as boolean;
}
