import { type InlineReturnLineDraft } from "./inline-return-state";

/** The product fields a scan resolves to (web `useScanCodeHandler`, mobile `resolveProductByCode`). */
export interface ScannedReturnProduct {
  id: string;
  name: string;
  unit?: string | null;
  unitsPerBox?: number | null;
}

function piecesOf(raw: string): number {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * #2694 — a scanned product lands in "What came back", the same on web and mobile:
 *   - a NEW product becomes a line with 1 piece (boxes blank — a boxed product is counted in pieces
 *     until the operator types boxes);
 *   - a REPEAT scan adds 1 piece to that product's line, keeping its key, position, boxes, reason
 *     and note.
 * `makeLine` adds each caller's own fields (web: `lineKey`; mobile: `soldLabel`). Pure — never
 * mutates `lines`. `created` tells a scan ladder whether the scan made the line (for its undo).
 */
export function applyReturnScan<L extends InlineReturnLineDraft>(
  lines: L[],
  product: ScannedReturnProduct,
  makeLine: (base: InlineReturnLineDraft) => L,
): { lines: L[]; created: boolean } {
  const at = lines.findIndex((l) => l.productId === product.id);
  if (at >= 0) {
    const next = lines.slice();
    next[at] = { ...lines[at], pieces: String(piecesOf(lines[at].pieces) + 1) };
    return { lines: next, created: false };
  }
  const line = makeLine({
    productId: product.id,
    productName: product.name,
    unit: product.unit,
    unitsPerBox: product.unitsPerBox ?? null,
    boxes: "",
    pieces: "1",
    reason: "",
    note: "",
  });
  return { lines: [...lines, line], created: true };
}
