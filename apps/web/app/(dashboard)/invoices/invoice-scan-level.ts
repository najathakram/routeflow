import { normalizeBoxesPieces, type SellLevel } from "@routeflow/pricing";
import { scanLevelForHit } from "../orders/_components/scan/useScanCodeHandler";
import { explicitBumpLevel, isUnitScanOnBoxed } from "../orders/[id]/scan-level-line";

// #2717 M4a-1 / SA-595c (1): the invoice screens' scan-level helpers. The LEVEL comes from the
// shared resolver the order screens use (`scanLevelForHit` -> `resolveScanSellLevel`), never a
// second derivation. A shared code resolves to the product's default unit, so it is exactly a
// picker tap; only a DISTINCT unit code resolves to UNIT.
export { scanLevelForHit };

// A UNIT scan on a boxed product (upb > 1) is ONE loose piece; anything else is today's line.
// One implementation: the order screen's `isUnitScanOnBoxed` (it takes the product-shaped arg).
const unitScanOnBoxed = (upb: number | undefined | null, level?: SellLevel): boolean =>
  isUnitScanOnBoxed({ unitsPerBox: upb }, level ?? "BOX");

/**
 * The boxes/pieces/qty a NEW line starts with. `upb` is the already-guarded pack (> 1 or
 * undefined, see boxedUnitsPerBox). qty is undefined for a plain line so the caller keeps its own.
 */
export function seedLineQty(
  upb: number | undefined,
  level?: SellLevel,
): { boxes?: number; pieces?: number; qty?: number } {
  if (!upb) return {};
  return unitScanOnBoxed(upb, level)
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
  const boxes = (it.boxes ?? 0) + (unitScanOnBoxed(upb, level) ? 0 : 1);
  const pieces = (it.pieces ?? 0) + (unitScanOnBoxed(upb, level) ? 1 : 0);
  const n = normalizeBoxesPieces({ boxes, pieces, unitsPerBox: upb });
  return { ...it, boxes: n.boxes ?? 0, pieces: n.pieces ?? 0, qty: n.qty };
}

/**
 * The qty (total pieces) a scan puts on an EDIT-invoice row, or undefined to leave the row's qty
 * alone (a picker tap, a shared code, upb <= 1). A distinct UNIT code is one loose piece; a
 * distinct BOX code (the shared explicit-BOX rule) is a whole case.
 */
export function scanRowQty(code: string, product: any): number | undefined {
  const upb = Number(product?.unitsPerBox ?? 0);
  if (!(upb > 1)) return undefined;
  if (unitScanOnBoxed(upb, scanLevelForHit(code, product))) return 1;
  return explicitBumpLevel(code, product) === "BOX" ? upb : undefined;
}
