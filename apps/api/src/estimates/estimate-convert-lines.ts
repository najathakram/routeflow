import { BadRequestException } from "@nestjs/common";
import type { ManualLineItem } from "../invoices/manual-invoice-lines";

/** The EstimateItem fields the conversion reads. */
export interface ConvertibleEstimateItem {
  description: string;
  productId: string | null;
  qty: unknown;
  unitPrice: unknown;
  boxes: number | null;
  pieces: number | null;
  unitLabel?: string | null;
  unitsPerBox?: number | null;
}

/**
 * The box size an estimate line was QUOTED with (B659), never the live product's:
 *   1. the line's own `unitsPerBox` snapshot, when it is greater than 1;
 *   2. else, for a line with boxes, EXACTLY derived from its own split: an estimate stores
 *      `qty = boxes x pack + pieces`, so `(qty - pieces) / boxes`, accepted only when it is an integer
 *      greater than 1 (older estimates stored boxes but no pack);
 *   3. else null (unknown).
 */
export function estimateLinePack(item: ConvertibleEstimateItem): number | null {
  const own = Number(item.unitsPerBox ?? 0);
  if (own > 1) return own;
  const boxes = Number(item.boxes ?? 0);
  if (boxes > 0) {
    const derived = (Number(item.qty) - Number(item.pieces ?? 0)) / boxes;
    if (Number.isInteger(derived) && derived > 1) return derived;
  }
  return null;
}

/**
 * An accepted estimate's lines as `buildManualInvoiceLines` input, so the invoice is built through the SAME
 * path as an interactive invoice (levy, unit resolution, ledger snapshot) at the sale-date rate, on the
 * QUOTED price. A product line with a box split whose pack cannot be established refuses the conversion
 * (never the live pack): the caller runs this before reserving an invoice number.
 */
export function estimateConvertLineItems(
  items: readonly ConvertibleEstimateItem[],
  lineTaxRate: number,
): ManualLineItem[] {
  return items.map((i, index) => {
    const hasSplit = i.productId != null && (i.boxes != null || i.pieces != null);
    const pack = hasSplit ? estimateLinePack(i) : null;
    if (hasSplit && pack == null) {
      throw new BadRequestException(`pack unknown for line ${index + 1}: re-save the estimate`);
    }
    return {
      description: i.description,
      productId: i.productId ?? undefined,
      qty: Number(i.qty),
      unitPrice: Number(i.unitPrice),
      boxes: i.boxes ?? undefined,
      pieces: i.pieces ?? undefined,
      unitLabel: i.unitLabel ?? undefined,
      discount: 0,
      taxRate: lineTaxRate,
      packSnapshot: pack,
    } as ManualLineItem;
  });
}
