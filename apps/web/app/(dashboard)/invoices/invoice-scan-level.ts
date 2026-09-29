import { normalizeBoxesPieces, type SellLevel } from "@routeflow/pricing";
import { scanLevelForHit } from "../orders/_components/scan/useScanCodeHandler";

// #2717 M4a-1 / SA-595c (1): the invoice screens' scan-level helpers. The LEVEL comes from the
// shared resolver the order screens use (`scanLevelForHit` -> `resolveScanSellLevel`), never a
// second derivation. A shared code resolves to the product's default unit, so it is exactly a
// picker tap; only a DISTINCT unit code resolves to UNIT.
export { scanLevelForHit };

/** A UNIT scan on a boxed product (upb > 1) is ONE loose piece; anything else is today's line. */
export function isUnitScanOnBoxed(upb: number | undefined | null, level?: SellLevel): boolean {
  return level === "UNIT" && Number(upb ?? 0) > 1;
}

/**
 * The boxes/pieces/qty a NEW line starts with. `upb` is the already-guarded pack (> 1 or
 * undefined, see boxedUnitsPerBox). qty is undefined for a plain line so the caller keeps its own.
 */
export function seedLineQty(
  upb: number | undefined,
  level?: SellLevel,
): { boxes?: number; pieces?: number; qty?: number } {
  if (!upb) return {};
  return isUnitScanOnBoxed(upb, level)
    ? { boxes: 0, pieces: 1, qty: 1 }
    : { boxes: 1, pieces: 0, qty: upb };
}

/**
 * Bump an existing line for a catalog add / scan. A boxed line takes +1 case (a tap, a shared or
 * BOX code) or +1 PIECE (a distinct UNIT code), re-normalised so a full case rolls up and no
 * quantity is hidden; a plain line is +1.
 */
export function bumpInvoiceLine<
  T extends { qty: number; unitsPerBox?: number; boxes?: number; pieces?: number },
>(it: T, level?: SellLevel): T {
  const upb = it.unitsPerBox;
  if (!upb) return { ...it, qty: Number(it.qty) + 1 };
  const boxes = (it.boxes ?? 0) + (isUnitScanOnBoxed(upb, level) ? 0 : 1);
  const pieces = (it.pieces ?? 0) + (isUnitScanOnBoxed(upb, level) ? 1 : 0);
  const n = normalizeBoxesPieces({ boxes, pieces, unitsPerBox: upb });
  return { ...it, boxes: n.boxes ?? 0, pieces: n.pieces ?? 0, qty: n.qty };
}
