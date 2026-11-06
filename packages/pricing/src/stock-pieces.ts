import { regulatedUnitBasis } from "./regulated-unit-basis";

/**
 * SA-1086: the ONE line-to-pieces conversion and the ONE per-product sum. `Product.currentStock` is
 * counted in PIECES, but a line's `qty` is in its own stored unit: pieces for a box-split or Units
 * line, BOXES for a box-unaware boxed line. The order save (`decrementStockForSale`, `settleStockForEdit`)
 * and the live stock note on the order screens both import these, so what staff are told while they
 * build an order is the number the save will judge. Never a second copy on either side.
 */

/** B703 (SA-136b): the unit fields a conversion reads off a line. */
export interface StockLineUnits {
  boxes?: unknown;
  pieces?: unknown;
  unitsPerBox?: unknown;
  unitLabel?: unknown;
}

/**
 * RF-4: the piece count a per-unit category tax multiplies. B679: a thin wrapper over
 * `regulatedUnitBasis` — the ONE place this conversion happens. `unitsPerBoxFallback` is the
 * PRODUCT's live `unitsPerBox`, used when the stored line didn't snapshot its own (a boxed
 * selling-unit line only snapshots `unitsPerBox` on a box-split; a Units/PO line's `unitLabel`
 * branch ignores both).
 */
export function linePieceQty(
  li: {
    qty: unknown;
    boxes: unknown;
    pieces?: unknown;
    unitsPerBox?: unknown;
    unitLabel?: unknown;
  },
  unitsPerBoxFallback?: number,
): number {
  const packAtSale = li.unitsPerBox != null ? Number(li.unitsPerBox) : unitsPerBoxFallback;
  // The `warn` result is discarded on purpose: the regulated ledger's own write point
  // (regulated-ledger.service.ts:91) is the one place this box-unaware fallback gets logged.
  return regulatedUnitBasis(
    {
      qty: Number(li.qty) || 0,
      boxes: li.boxes as number | null | undefined,
      pieces: li.pieces as number | null | undefined,
      unitLabel: li.unitLabel as string | null | undefined,
    },
    packAtSale,
  ).unitBasisQty;
}

/** `qty` (the line's own unit) in pieces, at the column's 3 decimals. Row 635: the ONE conversion the D2 repair uses too. */
export const toPieces = (li: StockLineUnits, qty: unknown, livePack: unknown): number => {
  const pack = livePack != null ? Number(livePack) : undefined;
  return Math.round(linePieceQty({ ...li, boxes: li.boxes ?? null, qty }, pack) * 1000) / 1000;
};

/** B920: pieces per product, summed ONCE at the column's 3 decimals (first-seen order). */
export const sumPiecesByProduct = (lines: Array<{ productId: string; pieces: number }>) => {
  const byProduct = new Map<string, number>();
  for (const li of lines) {
    const sum = (byProduct.get(li.productId) ?? 0) + li.pieces;
    byProduct.set(li.productId, Math.round(sum * 1000) / 1000);
  }
  return byProduct;
};
