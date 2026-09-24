/**
 * Pure box-unit resolution for the at-door "Adjust order" screen (B657).
 *
 * Extracted out of `app/(driver)/route/stop/[stopId]/adjust.tsx` (a route file jest
 * cannot import — expo-router hooks fire on import) so the one thing it got wrong is
 * separately, purely testable: which `unitsPerBox` a line's box math uses.
 */
import { normalizeBoxesPieces } from "@routeflow/pricing";
import { editedLineFreeUnits } from "./invoice-totals";

interface LineUnitsInput {
  unitsPerBox?: number | null;
  product?: { unitsPerBox?: number | null } | null;
}

/**
 * The line's own sale-time snapshot first, the live product only as a fallback for a
 * legacy line with no stored snapshot — never the other way (B657: this screen read
 * the live product ALONE, so a product repacked after the sale silently desynced an
 * already-agreed line: `isBoxed` could flip, and a boxed line could fall onto the
 * screen's plain "Qty" stepper, where "+1" adds one PIECE instead of one BOX). Same
 * rule as every other line-money site in the repo: web's order detail page,
 * `short-pick.ts`, the driver return screen — all `li.unitsPerBox ?? li.product?.unitsPerBox`.
 */
export function lineUnitsPerBox(li: LineUnitsInput): number {
  return Number(li.unitsPerBox ?? li.product?.unitsPerBox ?? 0);
}

interface FreeUnitsInput {
  unitsPerBox?: number | null;
  product?: { unitsPerBox?: number | null } | null;
  boxes?: number | null;
  pieces?: number | null;
  qty: number;
  promoFreeUnits?: number | null;
}

/**
 * BUY_N_GET_M free units for the at-door ESTIMATE, rescaled to the quantity the
 * driver has dialled in. Same rule as the order/invoice edit forms (and the
 * server's `rescaleBogoFreeUnits` fallback): the snapshot was earned at the
 * line's stored selling-unit count, so a shrunk line earns proportionally fewer
 * and a grown one never earns more than was already agreed. Loose pieces never
 * count — a boxed line's selling units are its BOXES.
 */
export function adjustLineFreeUnits(li: FreeUnitsInput, qty: number): number {
  const upb = lineUnitsPerBox(li);
  const stored = normalizeBoxesPieces({
    boxes: li.boxes,
    pieces: li.pieces,
    qty: li.qty,
    unitsPerBox: upb,
  });
  const now = normalizeBoxesPieces({ qty, unitsPerBox: upb });
  return editedLineFreeUnits({
    promoFreeUnits: li.promoFreeUnits,
    promoBaseUnits: upb > 1 ? stored.boxes : stored.qty,
    boxes: upb > 1 ? now.boxes : null,
    qty: now.qty,
  });
}
