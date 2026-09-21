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
 *
 * `packSnapshot` (B659) carries the line's own QUOTED pack unconditionally — not only for a box split. A
 * NO-SPLIT line (plain qty, no boxes/pieces) on a product quoted at a known box size still needs that same
 * pack for the per-piece levy basis (manual-invoice-lines.ts's `upbForPieces`), never the live product's, so
 * `estimateLinePack` runs for every line and the pack-unknown refusal below stays scoped to an actual split.
 *
 * `unitLabel` is never forwarded: a unit-aware estimate line is refused by the caller's pre-flight
 * (`assertNoUnitAwareLines`, run before this) — estimates cannot originate a unit-aware invoice line.
 *
 * A 0/0 "split" is NO split (B659 review finding 6): `boxes`/`pieces` are only ever forwarded when at
 * least one is genuinely positive. Forwarding a stray `boxes: 0, pieces: 0` would make
 * `buildManualInvoiceLines` run `normalizeBoxesPieces` on a boxed product and collapse the line's qty
 * to 0 pieces instead of leaving it as a plain qty line.
 */
export function estimateConvertLineItems(
  items: readonly ConvertibleEstimateItem[],
  lineTaxRate: number,
): ManualLineItem[] {
  return items.map((i, index) => {
    const hasSplit = i.productId != null && (Number(i.boxes ?? 0) > 0 || Number(i.pieces ?? 0) > 0);
    const pack = estimateLinePack(i);
    if (hasSplit && pack == null) {
      // There is no estimate-update path (B659): the only remedy is a fresh estimate.
      throw new BadRequestException(
        `pack unknown for line ${index + 1}: void this estimate and create a new one`,
      );
    }
    return {
      description: i.description,
      productId: i.productId ?? undefined,
      qty: Number(i.qty),
      unitPrice: Number(i.unitPrice),
      boxes: hasSplit ? (i.boxes ?? undefined) : undefined,
      pieces: hasSplit ? (i.pieces ?? undefined) : undefined,
      discount: 0,
      taxRate: lineTaxRate,
      packSnapshot: pack,
    } as ManualLineItem;
  });
}
