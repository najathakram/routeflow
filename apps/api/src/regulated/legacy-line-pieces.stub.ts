/**
 * STAND-IN for `legacyLinePieces(line, sourceLine?)` from `@routeflow/pricing` (Senior Architect ruling
 * 2026-09-21; U-units is building the real one). It exists ONLY so B660 can be drafted against the final
 * signature; when the real classifier lands this file and its spec are deleted and the one import in
 * regulated-ledger.service.ts is repointed at `@routeflow/pricing` (a pure import change: same names).
 *
 * The ruling's evidence order, and nothing else:
 *   (a) the line carries a boxes/pieces split -> qty already counts pieces: pieces = qty, basis "split".
 *   (b) a sourceLine for the SAME product carries a split:
 *         qty === source.boxes AND qty !== source.qty -> qty counted BOXES: pieces = source.qty ("source-boxes")
 *         qty === source.qty                          -> qty counted pieces: pieces = qty     ("source-pieces")
 *         anything else                               -> unknown.
 *   (c) no usable source -> unknown.
 * NEVER multiply by the live product's unitsPerBox (the product may have changed since the line was written,
 * and that guess is how this class of defect was born). A pack SNAPSHOT with no split is ambiguous (the
 * B644/B656 shape `{qty: 72, unitsPerBox: 12, boxes: null}` already counts pieces), so it is NOT evidence.
 */
export interface LegacyLine {
  qty: number;
  boxes: number | null;
  pieces: number | null;
  unitsPerBox: number | null;
}

export type LegacyPieces =
  | { pieces: number; basis: "split" | "source-boxes" | "source-pieces" }
  | { unknown: true; reason: string };

const hasSplit = (l: LegacyLine | null | undefined): l is LegacyLine =>
  !!l && (l.boxes != null || l.pieces != null);

export function legacyLinePieces(line: LegacyLine, sourceLine?: LegacyLine | null): LegacyPieces {
  const qty = Number(line.qty);
  // (a) the line's own split: qty already counts pieces.
  if (hasSplit(line)) return { pieces: qty, basis: "split" };
  // (b) a same-product source line with a split says how to read qty.
  if (hasSplit(sourceLine)) {
    const sourceQty = Number(sourceLine.qty);
    const sourceBoxes = sourceLine.boxes == null ? null : Number(sourceLine.boxes);
    if (sourceBoxes !== null && qty === sourceBoxes && qty !== sourceQty) {
      return { pieces: sourceQty, basis: "source-boxes" };
    }
    if (qty === sourceQty) return { pieces: qty, basis: "source-pieces" };
    return {
      unknown: true,
      reason: "the line qty matches neither the source line's boxes nor its qty",
    };
  }
  // (c) no usable source.
  return { unknown: true, reason: "no own split and no same-product source line with a split" };
}
