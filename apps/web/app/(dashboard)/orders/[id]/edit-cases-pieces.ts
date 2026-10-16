import { normalizeBoxesPieces } from "@routeflow/pricing";

/**
 * O1 (F06): the edit builder's glue for the shared cases + loose-pieces control. Pure, so the
 * money rule is testable without rendering: every change goes through `normalizeBoxesPieces`
 * (pieces roll over into cases) and the line then stores TOTAL pieces + `boxSplit`, which
 * `buildItemUpdates` turns into `boxes`/`pieces` and the server prorates. Never `qty * unitPrice`.
 */
interface CasesPiecesLine {
  qty: number;
  unitsPerBox?: number | null;
  boxSplit?: boolean;
  unitLabel?: string;
  countLocked?: boolean;
  cancelled?: boolean;
  isUnlisted?: boolean;
  substituteProductId?: string;
}

/** A classic boxed line: case-packed, not a units_v1 unit line, not locked, not mid-substitution. */
export function isCasesPiecesLine(it: CasesPiecesLine): boolean {
  return (
    Number(it.unitsPerBox ?? 0) > 1 &&
    !it.unitLabel &&
    !it.countLocked &&
    !it.cancelled &&
    !it.isUnlisted &&
    !it.substituteProductId
  );
}

/** What the control shows: the stored split, or whole cases for a line saved without a split. */
export function casesPiecesOf(it: CasesPiecesLine): { boxes: number; pieces: number } {
  const upb = Number(it.unitsPerBox ?? 0);
  if (it.boxSplit) {
    const s = normalizeBoxesPieces({ qty: it.qty, unitsPerBox: upb });
    return { boxes: s.boxes ?? 0, pieces: s.pieces ?? 0 };
  }
  return { boxes: it.qty, pieces: 0 };
}

/**
 * The line patch for a typed cases / loose value (NaN and negatives count as 0), or null when the
 * order would hold nothing (the field snaps back, as the plain Qty box did for 0).
 */
export function applyCasesPieces(
  it: CasesPiecesLine,
  next: { boxes: number; pieces: number },
): { qty: number; boxSplit: true; startOnDefaultUnit: false } | null {
  const clean = (n: number) => (Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0);
  const split = normalizeBoxesPieces({
    boxes: clean(next.boxes),
    pieces: clean(next.pieces),
    unitsPerBox: Number(it.unitsPerBox ?? 0),
  });
  if (split.qty <= 0) return null;
  return { qty: split.qty, boxSplit: true, startOnDefaultUnit: false };
}
