/**
 * The classifier for a STORED line whose own split may be missing (the box-unaware convention
 * this design retires — #938, 2026-09-21). Ruled once by the Senior Architect; signature and
 * evidence order are canonical — any caller (B661's write refusal, B646's read path, the history
 * report) imports THIS, never re-derives a piece count itself. `apps/api`'s
 * `no-second-legacy-line-pieces.spec.ts` fails the build if a second implementation appears.
 *
 * NEVER multiplies by a live product's `unitsPerBox` — a product's pack size can change after the
 * sale, so that would silently misclassify an old row with today's pack size. `unknown` is a
 * first-class result: a caller REFUSES or FLAGS on it, never defaults to a guessed number.
 *
 * Evidence, in order:
 *   (a) the line itself carries a split (`boxes` or `pieces` given) — its `qty` is already
 *       pieces. basis `"split"`.
 *   (b) a `sourceLine` for the SAME PRODUCT — verifying that is the CALLER's job; this function
 *       trusts whichever `sourceLine` it's given — carries a split:
 *         - `line.qty === sourceLine.boxes` AND `!== sourceLine.qty` — the line's `qty` was a
 *           BOX count copied from the source (the box-unaware convention). `pieces =
 *           sourceLine.qty` (the source's own, already-known piece count). basis
 *           `"source-boxes"`.
 *         - `line.qty === sourceLine.qty` — the line's `qty` was already a piece count, copied
 *           straight through. `pieces = line.qty`. basis `"source-pieces"`.
 *         - neither — the line's `qty` matches neither of the source's axes. `unknown`.
 *   (c) no split on the line and no usable source (missing, or itself has no split) — `unknown`.
 */

/** A line as this classifier needs it — a stored InvoiceItem/OrderItem/ReturnItem or similar. */
export interface LegacyLine {
  qty: number;
  boxes?: number | null;
  pieces?: number | null;
  unitsPerBox?: number | null;
}

export type LegacyLinePiecesBasis = "split" | "source-boxes" | "source-pieces";

export type LegacyLinePiecesResult =
  { pieces: number; basis: LegacyLinePiecesBasis } | { unknown: true; reason: string };

export function legacyLinePieces(
  line: LegacyLine,
  sourceLine?: LegacyLine | null,
): LegacyLinePiecesResult {
  if (line.boxes != null || line.pieces != null) {
    return { pieces: line.qty, basis: "split" };
  }

  if (sourceLine == null) {
    return { unknown: true, reason: "no split on the line and no source line to check against" };
  }
  if (sourceLine.boxes == null && sourceLine.pieces == null) {
    return {
      unknown: true,
      reason: "no split on the line, and the source line has no split either",
    };
  }

  if (line.qty === sourceLine.boxes && line.qty !== sourceLine.qty) {
    return { pieces: sourceLine.qty, basis: "source-boxes" };
  }
  if (line.qty === sourceLine.qty) {
    return { pieces: line.qty, basis: "source-pieces" };
  }

  return {
    unknown: true,
    reason: `line qty (${line.qty}) matches neither the source's boxes (${sourceLine.boxes}) nor its qty (${sourceLine.qty})`,
  };
}
