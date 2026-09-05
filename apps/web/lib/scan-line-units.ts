/**
 * Pure unit conversion for scanned vendor-bill lines — Boxes vs Pieces.
 *
 * THE money-critical invariant (`.claude/pipeline/decisions/2026-08-18-batch-architecture.md`
 * §A3): `lineInventoryDelta` on the API (`apps/api/src/vendor-bills/vendor-bills.service.ts`)
 * converts a bill line into inventory units ONLY when `packSize > 1` — a Boxes
 * line saved WITHOUT `packSize` books 1 piece at the case price instead of
 * `piecesPerBox` pieces at the per-piece price. That is the exact #335/#336
 * stock/AVCO corruption class. `toBillLine` therefore ALWAYS returns
 * `packSize` explicitly — `null` for pieces, the piecesPerBox integer for
 * boxes — so no caller can accidentally omit it.
 *
 * Byte-identical mirror of `apps/mobile/lib/scan-line-units.ts` — change both
 * together. Spec: `apps/mobile/__tests__/scan-line-units.test.ts` is the
 * executable contract for BOTH mirrors.
 */
import { roundUnitCost } from "@routeflow/pricing";

export type ScanLineUnit = "pieces" | "boxes";

/** The canonical, unit-independent snapshot a scanned line is always kept as. */
export interface PieceSnapshot {
  qtyPieces: number;
  costPerPiece: number;
}

export interface BillLineDenomination {
  /** In the chosen unit — cases when unit="boxes", pieces when unit="pieces". */
  qty: number;
  /** Per chosen unit, rounded via `roundUnitCost` (4dp). */
  unitCost: number;
  /** piecesPerBox when unit="boxes" and the conversion succeeded, else null. ALWAYS present. */
  packSize: number | null;
  /** True only when this line was actually converted into a boxes representation. */
  converted: boolean;
  warning?: "NOT_DIVISIBLE" | "PPB_MISMATCH";
}

/** Boxes requires an INTEGER piecesPerBox >= 2 — 1 "per box" isn't boxed at all. */
function isValidBoxPpb(n: number | null | undefined): n is number {
  return typeof n === "number" && Number.isFinite(n) && Number.isInteger(n) && n >= 2;
}

/**
 * Denominate a scanned line's canonical piece snapshot into the operator's
 * chosen unit.
 *
 * - `unit="pieces"` always succeeds: `{qty: qtyPieces, unitCost: roundUnitCost(costPerPiece), packSize: null}`.
 * - `unit="boxes"` requires an integer `piecesPerBox >= 2` that evenly divides
 *   `qtyPieces`. When it doesn't, this falls back to the PIECES form plus
 *   `warning: "NOT_DIVISIBLE"` — a fractional case count is never returned;
 *   it would drift stock at receive.
 * - When a successful boxes conversion's effective `piecesPerBox` differs
 *   from `catalogUnitsPerBox`, the result carries `warning: "PPB_MISMATCH"`
 *   but still uses the on-screen `piecesPerBox` — what is displayed is what
 *   is saved. The catalog value is only ever a prefill for when OCR gave none.
 */
export function toBillLine(
  snap: PieceSnapshot,
  unit: ScanLineUnit,
  piecesPerBox: number | null | undefined,
  catalogUnitsPerBox?: number | null,
): BillLineDenomination {
  if (unit === "pieces") {
    return {
      qty: snap.qtyPieces,
      unitCost: roundUnitCost(snap.costPerPiece),
      packSize: null,
      converted: false,
    };
  }

  if (!isValidBoxPpb(piecesPerBox) || snap.qtyPieces % piecesPerBox !== 0) {
    return {
      qty: snap.qtyPieces,
      unitCost: roundUnitCost(snap.costPerPiece),
      packSize: null,
      converted: false,
      warning: "NOT_DIVISIBLE",
    };
  }

  const line: BillLineDenomination = {
    qty: snap.qtyPieces / piecesPerBox,
    unitCost: roundUnitCost(snap.costPerPiece * piecesPerBox),
    packSize: piecesPerBox,
    converted: true,
  };
  if (catalogUnitsPerBox != null && catalogUnitsPerBox !== piecesPerBox) {
    line.warning = "PPB_MISMATCH";
  }
  return line;
}
