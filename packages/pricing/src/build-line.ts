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
 *     `Decimal(10,3)` in the schema, so a fractional value is legitimate) but must be positive
 *     and finite (G1); boxes/pieces sent on a non-boxed axis are refused, never silently dropped
 *     (G1); a split given alongside a qty that disagrees with it is refused, never resolved by
 *     picking the split (G3).
 *   - `unit`: a named denomination off the product's unit ladder — mirrors
 *     `apps/api/src/orders/unit-line-build.ts`'s `buildUnitLine`: `boxes = count`,
 *     `qty = count x factorToBase`, `unitsPerBox = factorToBase` (the snapshot), EXCEPT a
 *     factor-1 unit (a Piece off a boxed pack), which is `boxes: null, pieces: null, qty: count`
 *     — a plain per-piece line that still snapshots its factor. `count` must be a whole number
 *     (G2) — 1.5 Cases is not a real quantity.
 *
 * CALLERS (SA-982): `orders/unit-line-build.ts` and `invoices/invoice-unit-line.ts` build through this (SA-145(1), #1341).
 * `buildInvoiceItemData` is deliberately NOT one: it prorates the STORED subtotal and must never recompute from
 * `unitPrice` (SA-145(1)). The hand-built pack-axis NEW-write builders (`normalizeBoxesPieces` with client `boxes:`, priced by
 * `computeLineSubtotal`) are a CLASS pinned in `apps/api/src/common/no-bare-line-math.spec.ts`; each converts here, one
 * domain at a time, behind a warn phase. Existing ROWS are never rewritten: this only shapes a new write.
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
    if (!label)
      throw new AmbiguousLineError("buildLine: a unit axis needs a non-blank label", "BAD_QTY");
    // G2 (R-ui review, 2026-09-21): a unit count is a COUNT of whole units (3 Cases) — Math.trunc
    // alone silently billed 1.5 Cases as 1. Refuse a non-integer instead of rounding it away.
    const rawCount = Number(axis.count);
    if (!Number.isInteger(rawCount)) {
      throw new AmbiguousLineError(
        `buildLine: unit count must be an integer, got ${axis.count}`,
        "NON_INTEGER",
      );
    }
    const count = rawCount;
    if (!(count > 0)) {
      throw new AmbiguousLineError(`buildLine: unit count must be > 0 (got ${axis.count})`, "ZERO");
    }
    // N2 (R-ui review, optional — factorToBase is integer upstream anyway, but the same guard
    // is one line): a fractional factor has no meaning (pieces per unit is always whole).
    const factor = Number(axis.factorToBase);
    if (!Number.isInteger(factor) || !(factor > 0)) {
      throw new AmbiguousLineError(
        `buildLine: "${label}" needs a positive integer factorToBase (got ${axis.factorToBase})`,
        "BAD_QTY",
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
    //
    // G1 (R-ui review, 2026-09-21): a caller that sends boxes/pieces here (this axis resolved
    // non-boxed — unitsPerBox <= 1 — so they're silently IGNORED below) almost certainly meant
    // the boxed branch and has a bug (a product misreported as not boxed, or a stale
    // unitsPerBox). Refuse rather than quietly drop them. And qty itself must be a positive,
    // finite number — `Number(undefined ?? 0)` defaulting to 0 used to price the line at $0
    // instead of refusing (the same "silent wrong money" shape as the B644 family).
    if (axis.boxes != null || axis.pieces != null) {
      throw new AmbiguousLineError(
        "buildLine: boxes/pieces given but this axis is non-boxed (unitsPerBox <= 1) — they would be silently dropped",
        "SPLIT_NO_PACK",
      );
    }
    const qty = Number(axis.qty);
    if (!Number.isFinite(qty) || qty <= 0) {
      throw new AmbiguousLineError(
        `buildLine: qty must be a positive, finite number, got ${axis.qty}`,
        "BAD_QTY",
      );
    }
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
      "BOXED_NO_SPLIT",
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
      throw new AmbiguousLineError(
        `buildLine: ${name} must be an integer, got ${v}`,
        "NON_INTEGER",
      );
    }
  }
  // G3 (R-ui review, 2026-09-21): a split AND a qty that disagrees with it (boxes:1, pieces:0,
  // qty:5, upb:12 — implies 12, not 5) used to silently drop the caller's qty, since
  // normalizeBoxesPieces ignores qty whenever a split is given. Refuse rather than pick a
  // winner — a caller sending both has a bug. Compared against the RAW (unrolled) split, so an
  // unrolled-but-otherwise-consistent qty (matching the split before rollover) is still fine.
  if (axis.qty != null) {
    const rawQty = Number(axis.qty);
    const impliedQty = Number(axis.boxes ?? 0) * upb + Number(axis.pieces ?? 0);
    if (Number.isFinite(rawQty) && rawQty !== impliedQty) {
      throw new AmbiguousLineError(
        `buildLine: qty (${axis.qty}) disagrees with boxes*unitsPerBox+pieces (${impliedQty}) — the split and the qty must agree`,
        "QTY_DISAGREES",
      );
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
  // N1 (R-ui review, 2026-09-21): boxes:0, pieces:0 passes every check above (both given, so
  // "neither given" doesn't fire; 0 is an integer; 0 disagrees with nothing) and used to mint a
  // $0 line — matches G1, the unit axis and create()'s own "> 0" requirement.
  if (!(normalized.qty > 0)) {
    throw new AmbiguousLineError(
      `buildLine: qty must be > 0, got boxes:${axis.boxes} pieces:${axis.pieces} (${normalized.qty} total)`,
      "ZERO",
    );
  }
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
