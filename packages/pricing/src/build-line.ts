/**
 * The line-builder choke point for a NEW write (design doc
 * `.claude/handoffs/2026-09-21-money-helper-refuses-ambiguity-PROPOSAL.md`, posted on #938
 * 2026-09-21 — the "refuse ambiguity" proposal against the owner's ruling to retire the
 * box-unaware convention for new writes).
 *
 * Two axes, matching what a line can actually be sold by:
 *   - `pack`: the product's own box/piece split — mirrors `buildInvoiceItemData` /
 *     `orders.service.ts`'s pack branch. A boxed product (`unitsPerBox > 1`) must supply
 *     boxes/pieces on the RAW input — `buildLine` itself throws otherwise (the B644 shape),
 *     before ever normalizing. A non-boxed product's `qty` is never truncated (it is
 *     `Decimal(10,3)` in the schema, so a fractional value is legitimate).
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

  if (!(upb > 1)) {
    // Non-boxed: qty is the operator's raw value (OrderItem.qty is Decimal(10,3) — a fractional
    // selling quantity, e.g. 1.5 kg, is legitimate). normalizeBoxesPieces' non-boxed branch does
    // Math.trunc, which would silently drop 1.5 -> 1 — never truncate here (Senior Architect
    // review, HOLD 1, 2026-09-21). computeLineSubtotalStrict's own integer check is boxed-only
    // (see lineAmbiguity), so a fractional qty passes through unmolested.
    const qty = Number(axis.qty ?? 0);
    const subtotal = computeLineSubtotalStrict({
      unitPrice,
      qty,
      boxes: null,
      pieces: null,
      unitsPerBox: axis.unitsPerBox,
      freeUnits,
    });
    return {
      qty,
      boxes: null,
      pieces: null,
      unitsPerBox: null,
      unitLabel: null,
      unitPrice,
      subtotal,
    };
  }

  // Boxed: a raw qty alone is ambiguous (per-box vs per-piece — the B644 shape). Checked on the
  // RAW input, before normalizing (HOLD 2) — normalizeBoxesPieces' qty-only branch would happily
  // (and wrongly) treat a bare qty as already-expanded pieces here.
  if (axis.boxes == null && axis.pieces == null) {
    throw new AmbiguousLineError(
      "buildLine: unitsPerBox > 1 with neither boxes nor pieces given — qty alone is ambiguous (per-box vs per-piece); the B644 shape",
    );
  }
  // A real physical box/piece count is never fractional — checked here, on the RAW input, for
  // the same reason as the "neither given" check above: normalizeBoxesPieces silently
  // Math.trunc's boxes/pieces, which would otherwise make this unreachable through buildLine
  // (the same "unreachable guard" shape HOLD 2 already flagged for the stale-split case).
  for (const [name, v] of [
    ["boxes", axis.boxes],
    ["pieces", axis.pieces],
  ] as const) {
    if (v != null && !Number.isInteger(Number(v))) {
      throw new AmbiguousLineError(`buildLine: ${name} must be an integer, got ${v}`);
    }
  }
  // A split WAS given (however stale — e.g. pieces >= unitsPerBox): normalize it here, then hand
  // strict the NORMALIZED split, never the raw one. Strict's own "pieces >= unitsPerBox" guard
  // exists only to protect a caller that skips buildLine entirely — routed through buildLine it
  // never fires, because buildLine always resolves the split before strict ever sees it (HOLD 2;
  // the previous doc comment claiming this was aspirational, not true — passing the raw split
  // made a merely-unrolled-but-valid split [e.g. 1 box + 14 of a 12-pack] throw instead of
  // rolling over to 2 boxes + 2).
  const normalized = normalizeBoxesPieces({
    boxes: axis.boxes,
    pieces: axis.pieces,
    qty: axis.qty,
    unitsPerBox: axis.unitsPerBox,
  });
  const subtotal = computeLineSubtotalStrict({
    unitPrice,
    qty: normalized.qty,
    boxes: normalized.boxes,
    pieces: normalized.pieces,
    unitsPerBox: axis.unitsPerBox,
    freeUnits,
  });
  return {
    qty: normalized.qty,
    boxes: normalized.boxes,
    pieces: normalized.pieces,
    // normalizeBoxesPieces' boxed branch always returns non-null boxes/pieces, so this is
    // unconditional — mirrors `products/line-units.ts`'s `lineUnitsPerBoxSnapshot` "boxed" rule.
    unitsPerBox: upb,
    unitLabel: null,
    unitPrice,
    subtotal,
  };
}
