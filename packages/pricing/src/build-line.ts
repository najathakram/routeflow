/**
 * The line-builder choke point for a NEW write (design doc
 * `.claude/handoffs/2026-09-21-money-helper-refuses-ambiguity-PROPOSAL.md`, posted on #938
 * 2026-09-21 — the "refuse ambiguity" proposal against the owner's ruling to retire the
 * box-unaware convention for new writes).
 *
 * Two axes, matching what a line can actually be sold by:
 *   - `pack`: the product's own box/piece split — mirrors `buildInvoiceItemData` /
 *     `orders.service.ts`'s pack branch. A boxed product (`unitsPerBox > 1`) must supply
 *     boxes/pieces; `computeLineSubtotalStrict` throws otherwise (the B644 shape).
 *   - `unit`: a named denomination off the product's unit ladder — mirrors
 *     `apps/api/src/orders/unit-line-build.ts`'s `buildUnitLine`: `boxes = count`,
 *     `qty = count x factorToBase`, `unitsPerBox = factorToBase` (the snapshot), EXCEPT a
 *     factor-1 unit (a Piece off a boxed pack), which is `boxes: null, pieces: null, qty: count`
 *     — a plain per-piece line that still snapshots its factor.
 *
 * NO CALLERS YET (PR-1 of the proposal). The three existing builders
 * (`orders/unit-line-build.ts`, `invoices/invoice-unit-line.ts`, `invoices.service.ts`'s
 * `buildInvoiceItemData`) keep calling `computeLineSubtotal`/`normalizeBoxesPieces` directly and
 * get re-pointed at this one at a time, checked against the copier-contract registry
 * (`apps/api/src/common/testing/copier-contract/`, #1163) per site. Existing ROWS are never
 * rewritten — this only shapes a new write.
 */
import { AmbiguousLineError, computeLineSubtotalStrict, normalizeBoxesPieces } from "./pricing";

export interface PackAxis {
  kind: "pack";
  /** A box/piece split (required when the product is boxed) or a raw qty (non-boxed only). */
  boxes?: number | null;
  pieces?: number | null;
  qty?: number | null;
  /** The product's box size; null/1 = not boxed. */
  unitsPerBox?: number | null;
}

export interface UnitAxis {
  kind: "unit";
  /** The denomination, e.g. "Case" — never the pack's own label (the caller's pack branch owns that). */
  label: string;
  /** How many of `label` this line sells (3 Cases = 3). */
  count: number;
  /** Pieces per ONE `label` — `resolveLineUnits`'s result, snapshotted verbatim even when 1. */
  factorToBase: number;
}

export interface BuildLineInput {
  axis: PackAxis | UnitAxis;
  /** Price per SELLING unit: per box on the pack axis, per `label` on the unit axis. */
  unitPrice: number;
  freeUnits?: number;
}

export interface BuiltLine {
  qty: number;
  boxes: number | null;
  pieces: number | null;
  unitsPerBox: number | null;
  unitLabel: string | null;
  unitPrice: number;
  subtotal: number;
}

export function buildLine(input: BuildLineInput): BuiltLine {
  const { axis, unitPrice, freeUnits } = input;

  if (axis.kind === "unit") {
    const label = axis.label.trim();
    if (!label) throw new AmbiguousLineError("buildLine: a unit axis needs a non-blank label");
    const count = Math.trunc(Number(axis.count));
    if (!(count > 0)) {
      throw new AmbiguousLineError(`buildLine: unit count must be > 0 (got ${axis.count})`);
    }
    const factor = Math.trunc(Number(axis.factorToBase));
    if (!(factor > 0)) {
      throw new AmbiguousLineError(
        `buildLine: "${label}" needs a positive factorToBase (got ${axis.factorToBase})`,
      );
    }
    const split =
      factor === 1
        ? { boxes: null, pieces: null, qty: count }
        : normalizeBoxesPieces({ boxes: count, pieces: 0, unitsPerBox: factor });
    const subtotal = computeLineSubtotalStrict({
      unitPrice,
      qty: split.qty,
      boxes: split.boxes,
      pieces: split.pieces,
      unitsPerBox: factor,
      freeUnits,
    });
    return {
      qty: split.qty,
      boxes: split.boxes,
      pieces: split.pieces,
      unitsPerBox: factor,
      unitLabel: label,
      unitPrice,
      subtotal,
    };
  }

  const upb = Number(axis.unitsPerBox ?? 0);
  const normalized = normalizeBoxesPieces({
    boxes: axis.boxes,
    pieces: axis.pieces,
    qty: axis.qty,
    unitsPerBox: axis.unitsPerBox,
  });
  // Strict sees the CALLER's raw boxes/pieces (not the normalized/back-filled ones) so a boxed
  // product that gave qty alone still trips the B644 guard instead of silently normalizing past it.
  const subtotal = computeLineSubtotalStrict({
    unitPrice,
    qty: normalized.qty,
    boxes: axis.boxes ?? null,
    pieces: axis.pieces ?? null,
    unitsPerBox: axis.unitsPerBox,
    freeUnits,
  });
  return {
    qty: normalized.qty,
    boxes: normalized.boxes,
    pieces: normalized.pieces,
    // Mirrors `products/line-units.ts`'s `lineUnitsPerBoxSnapshot` "boxed" rule: only a real
    // box-split line snapshots the box size; a non-boxed product's line stores null.
    unitsPerBox: normalized.boxes != null && upb > 1 ? upb : null,
    unitLabel: null,
    unitPrice,
    subtotal,
  };
}
