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

import { componentPriceText, invoiceLineQtyText } from "@routeflow/pricing";
import type { InvoiceDisplayLines } from "@routeflow/pricing";
import type { LineComponentView } from "@routeflow/types";

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
 * Whether the struck-through pre-promo `originalPrice` renders beside the charged unit price: the ONE rule now lives in
 * `@routeflow/pricing` (`showOriginalPrice`) so the receipts read the same decision; re-exported here for the invoice PDF,
 * the invoice email and the web renderer's mirror.
 */
export { showOriginalPrice } from "@routeflow/pricing";

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
 * B653: the invoice PDF's qty-column text — the SAME `invoiceLineQtyText` formatter
 * web (`apps/web/lib/invoice-line-unit.ts`) and mobile (`invoice-line-display.ts`)
 * call, so a units_v1 line reads identically everywhere: "3 Cases" for a boxed
 * split, never "3 boxes"; "5 Piece" for a factor-1 unit (no split to attach the
 * label to), never a bare "5". A pack line (no `unitLabel`) is unchanged.
 */
export function qtyCellText(item: InvoicePdfQtyItemLike): string {
  return invoiceLineQtyText({
    qty: toNum(item.qty),
    boxes: item.boxes,
    pieces: item.pieces,
    unitLabel: item.unitLabel,
  });
}

/** boxes/pieces/unitLabel, normalized — the fields an invoice-email item payload
 *  threads through for `qtyCellText` on its own send (B653). */
export function invoiceItemQtyFields(item: {
  boxes?: number | string | null;
  pieces?: number | string | null;
  unitLabel?: string | null;
}): { boxes: number | null; pieces: number | null; unitLabel: string | null } {
  return {
    boxes: item.boxes != null ? Number(item.boxes) : null,
    pieces: item.pieces != null ? Number(item.pieces) : null,
    unitLabel: item.unitLabel ?? null,
  };
}

/** One printed sub-line of a composed (mixed-pack) invoice line. */
export interface PdfSubLine {
  name: string;
  unitSku: string | null;
  barcodeText: string | null;
  barcodeDataUri: string | null;
  qtyText: string;
  /** "$0.63 (included)": the frozen 4-dp price viewed at 2 dp. Display only, never summed (I5). */
  priceText: string;
}

/**
 * #2717 M3 (SA-579 case 21): the sub-line of one frozen component, from its client view. The text
 * parts come from `@routeflow/pricing` (`componentPriceText`, the same helper `componentSubLineText`
 * uses), so the PDF, web and mobile read identically. `barcodeDataUri` is rendered by the caller
 * (bwip-js) because it is I/O.
 */
export function pdfSubLine(view: LineComponentView, barcodeDataUri: string | null): PdfSubLine {
  return {
    name: view.name,
    unitSku: view.unitSku,
    barcodeText: view.unitBarcode,
    barcodeDataUri,
    qtyText: `x ${view.qty}`,
    priceText: componentPriceText(view.displayUnitPrice4),
  };
}

/** SA-827: a piece price at 4 dp ("$2.0005"). The ONE formatter for the PDF's display units; money is never computed here. */
export function pieceUnitPriceText(n: number): string {
  return `$${n.toFixed(4)}`;
}

const amountText = (n: number): string => `$${n.toFixed(2)}`;

/** One component row of a components-layout line. */
export interface PdfDisplayRow {
  name: string;
  unitSku: string | null;
  barcodeText: string | null;
  barcodeDataUri: string | null;
  qtyText: string;
  priceText: string;
  amountText: string;
}

/** What the template renders for one item: its own today row, or the SA-827 piece/component layouts. */
export type PdfItemDisplay =
  | { layout: "today" }
  | { layout: "pieces"; qtyText: string; priceText: string; hideOriginalPrice: true }
  | {
      layout: "components";
      rows: PdfDisplayRow[];
      group: { description: string; amountText: string };
      categoryTax: { label: string; amountText: string } | null;
    };

/**
 * SA-827: maps an `invoiceDisplayLines` value to the template's row objects. Every number comes from `lines`;
 * this only formats. `barcodes` maps componentProductId -> rendered barcode data URI (I/O done by the caller).
 */
export function pdfItemDisplay(
  lines: InvoiceDisplayLines,
  barcodes?: ReadonlyMap<string, string | null>,
): PdfItemDisplay {
  if (lines.layout === "today") return { layout: "today" };
  if (lines.layout === "pieces") {
    return {
      layout: "pieces",
      qtyText: `${lines.qty} ${lines.unitLabel}`,
      priceText: pieceUnitPriceText(lines.unitPrice),
      hideOriginalPrice: true,
    };
  }
  return {
    layout: "components",
    rows: lines.rows.map((r) => ({
      name: r.name,
      unitSku: r.unitSku,
      barcodeText: r.unitBarcode,
      barcodeDataUri: barcodes?.get(r.componentProductId) ?? null,
      qtyText: `${r.qty} ${r.unitLabel}`,
      priceText: pieceUnitPriceText(r.unitPrice),
      amountText: amountText(r.amount),
    })),
    group: {
      description: lines.groupTotal.description,
      amountText: amountText(lines.groupTotal.amount),
    },
    categoryTax: lines.categoryTax
      ? { label: lines.categoryTax.label, amountText: amountText(lines.categoryTax.amount) }
      : null,
  };
}
