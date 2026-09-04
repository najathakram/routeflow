/**
 * One-line "2 cases + 1 loose · $54.00" for an added case-packed row.
 *
 * Extracted from the two sale builders, which carried byte-identical copies.
 * `unitPrice` must arrive RESOLVED (override else tier/catalog price) — the
 * builders resolve it differently (NewOrderScreen is tier-aware, the invoice
 * builder is not), so this helper never sees a Product. The subtotal is
 * computed from the same raw line fields the builders' footer memos pass to
 * `computeLineSubtotal`, so the row summary and the footer total are
 * byte-identical by construction. Spec: __tests__/boxed-line-summary.test.ts.
 *
 * KNOWN SHARP EDGE (unreachable today, pinned by the spec): a boxed line with
 * qty but NO stored split would hit computeLineSubtotal's per-piece fallback —
 * case price × piece count. Every sale-line helper writes boxes/pieces, so the
 * state can't arise from the UI; if you ever add a path that creates boxed
 * lines from a bare qty, normalize the split FIRST (see setLineUnits).
 */
import { computeLineSubtotal, normalizeBoxesPieces } from "@routeflow/pricing";

export interface BoxedSummaryLine {
  qty: number;
  boxes?: number | null;
  pieces?: number | null;
}

export function boxedLineSummary(
  line: BoxedSummaryLine,
  unitsPerBox: number | null | undefined,
  unitPrice: number,
): string {
  const split = normalizeBoxesPieces({
    boxes: line.boxes,
    pieces: line.pieces,
    qty: line.qty,
    unitsPerBox,
  });
  const boxes = split.boxes ?? 0;
  const pieces = split.pieces ?? 0;
  const parts: string[] = [];
  if (boxes > 0) parts.push(`${boxes} case${boxes === 1 ? "" : "s"}`);
  if (pieces > 0) parts.push(`${pieces} loose`);
  // Raw line fields, exactly as the footer memo passes them — the two totals
  // must be byte-identical.
  const subtotal = computeLineSubtotal({
    unitPrice,
    qty: split.qty,
    boxes: line.boxes ?? null,
    pieces: line.pieces ?? null,
    unitsPerBox: unitsPerBox ?? null,
  });
  return `${parts.join(" + ") || "0"} · $${subtotal.toFixed(2)}`;
}
