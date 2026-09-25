import { regulatedUnitBasis } from "@routeflow/pricing";

/**
 * RF-4: the piece count a per-unit category tax multiplies. B679: a thin wrapper over
 * `regulatedUnitBasis` (`@routeflow/pricing`) — the ONE place this conversion happens — rather
 * than an independent copy of its box-unaware fallback branch. `unitsPerBoxFallback` is the
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
