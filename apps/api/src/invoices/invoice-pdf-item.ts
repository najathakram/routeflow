/**
 * Per-line promo/original-price/qty-label display decisions for the invoice PDF (F03 R9,
 * B653).
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

import { formatQtySplit } from "@routeflow/pricing";

/** Mirrors `invoice-pdf-template.tsx`'s own `DecimalLike` — a Prisma Decimal, a plain
 *  number, or a numeric string, all seen on the wire depending on the read path. */
type DecimalLike = { toNumber(): number } | number | string;

const toNum = (val: DecimalLike): number => {
  if (typeof val === "number") return val;
  if (typeof val === "string") return parseFloat(val);
  return val.toNumber();
};

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

export type InvoicePdfQtyItemLike = {
  qty: DecimalLike;
  boxes?: number | null;
  pieces?: number | null;
  /** units_v1 (2026-09-19): the line's own selling unit ("Case") when this line was
   *  sold by a non-pack unit rather than by loose pieces — see `buildInvoiceUnitLine`.
   *  A units_v1 line stores `boxes = count` (the unit count, NOT box count) and
   *  `pieces = 0`, so without this the qty cell reads "N boxes" for a genuine "N Case"
   *  line (B653). */
  unitLabel?: string | null;
};

/**
 * B653: the invoice PDF's qty-column text — "2 boxes + 3 pcs" for an ordinary boxed
 * line, unchanged, but "3 Case" (not "3 boxes") for a units_v1 line, whose own
 * `unitLabel` is the box-level label `formatQtySplit` was already built to accept
 * (units/PO minimal, 2026-09-19) and this template simply never passed through.
 * `unitLabel` is used ONLY as `boxLabel` here — `formatQtySplit`'s own `unitLabel`
 * param names the LOOSE-PIECE noun (defaults "pcs"), a different axis a units_v1
 * line's `pieces: 0` never reaches anyway.
 */
export function qtyCellText(item: InvoicePdfQtyItemLike): string {
  return formatQtySplit({
    qty: toNum(item.qty),
    boxes: item.boxes,
    pieces: item.pieces,
    boxLabel: item.unitLabel,
  });
}
