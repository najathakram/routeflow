/**
 * THE conversion from a stored line's own shape to the piece count a regulated levy is computed
 * on (Senior Architect ruling, B661/B671, 2026-09-21). Used at WRITE time only — when a line's
 * shape and the product's pack size, AS THEY WERE AT THAT MOMENT, are both in hand — never to
 * re-read an old row later (that's `legacyLinePieces`'s job: it has no `packAtSale` to trust,
 * because a product's pack size can change after the sale).
 *
 * `packAtSale` MUST be the product's `unitsPerBox` captured at the same moment as `line` (the
 * write transaction), never a later re-read of the live product — the box-unaware branch (4)
 * below is a best-effort fallback specifically because the line itself doesn't say, and reading
 * today's pack for a line written yesterday reintroduces the bug this design retires.
 *
 * Branches, in order — the FIRST one that applies wins:
 *   (1) `line.unitLabel` is set — a Units/PO line: `qty` is already in the line's own base
 *       selling unit. `unitBasisQty = qty`.
 *   (2) `line.boxes` or `line.pieces` is set (a box-split line, whichever branch is null) —
 *       `qty` is already a piece count. `unitBasisQty = qty`.
 *   (3) neither of the above, and `packAtSale` is not a real pack (`<= 1`, `null`, missing) —
 *       an ordinary non-boxed product. `unitBasisQty = qty`.
 *   (4) neither of the above, and `packAtSale > 1` — the box-unaware convention this design
 *       retires: a boxed product sold in SELLING UNITS with no split recorded. `unitBasisQty =
 *       qty * packAtSale`, and the result carries a `warn` reason — this is the ONE place that
 *       expansion still happens, done at write time against the pack AS SNAPSHOT, not guessed
 *       later. A future diff (once `buildLine` is wired everywhere so this branch never fires)
 *       turns this into a throw instead of a warn.
 *
 * This is NOT `legacyLinePieces` (packages/pricing/src/legacy-line-pieces.ts) — that classifier
 * reads a row back later with no write-time context and refuses to guess; this function is the
 * one write-time place allowed to fall back to a snapshot pack. `apps/api`'s
 * `no-second-legacy-line-pieces.spec.ts` is widened to fail the build on a second function
 * anywhere that multiplies a boxes-null qty by a pack size — this is the only one left standing.
 */

export interface RegulatedUnitBasisLine {
  qty: number;
  boxes?: number | null;
  pieces?: number | null;
  unitsPerBox?: number | null;
  unitLabel?: string | null;
}

export interface RegulatedUnitBasisResult {
  unitBasisQty: number;
  /** Set only on the box-unaware fallback (branch 4) — the caller logs it. */
  warn?: string;
}

export function regulatedUnitBasis(
  line: RegulatedUnitBasisLine,
  packAtSale: number | null | undefined,
): RegulatedUnitBasisResult {
  const qty = Number(line.qty);

  // (1) a Units/PO line: qty is already in the line's own base unit.
  if (line.unitLabel != null) {
    return { unitBasisQty: qty };
  }
  // (2) a box-split line: qty is already a piece count.
  if (line.boxes != null || line.pieces != null) {
    return { unitBasisQty: qty };
  }

  const pack = Number(packAtSale ?? 0);
  // (3) no split, and the product isn't (or wasn't, at sale time) boxed at all.
  if (!(pack > 1)) {
    return { unitBasisQty: qty };
  }

  // (4) box-unaware: the only place this design still expands qty by a pack — at write time,
  // against the snapshot pack, never a later re-read.
  return {
    unitBasisQty: qty * pack,
    warn:
      `B644: box-unaware line (qty ${line.qty}, no boxes/pieces split, no unitLabel) ` +
      `expanded by packAtSale ${pack} at write time — write-time snapshot only, never re-derived later`,
  };
}
