import { normalizeBoxesPieces } from "@routeflow/pricing";
import type { TrayRow } from "./scan-tray";
import type { PrefilledReturnLine } from "./inline-return-screen";

/**
 * #2694 — returns scan into "What came back" through the SAME ScanOrderSheet as order items. These
 * pure helpers adapt the return lines to the sheet's tray: rows carry no money (a return line has no
 * price until the quote), and the tray's qty / stepper edits land back on the lines in pieces.
 */

function count(raw: string): number {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function packOf(line: PrefilledReturnLine): number | null {
  const upb = Number(line.unitsPerBox ?? 0);
  return upb > 1 ? upb : null;
}

/** Total pieces on a return line: boxes × pack + pieces (a non-boxed line is its pieces). */
export function returnLinePieces(line: PrefilledReturnLine): number {
  const pack = packOf(line);
  return (pack ? count(line.boxes) * pack : 0) + count(line.pieces);
}

function qtySummary(line: PrefilledReturnLine): string {
  const pack = packOf(line);
  const boxes = pack ? count(line.boxes) : 0;
  const pieces = count(line.pieces);
  if (boxes > 0 && pieces > 0) return `${boxes} bx + ${pieces}`;
  if (boxes > 0) return `${boxes} bx`;
  return String(pieces);
}

/** Tray rows for the scan sheet: the scan order first (newest first), then every other line. */
export function returnTrayRows(
  lines: readonly PrefilledReturnLine[],
  scanOrder: readonly string[],
): TrayRow[] {
  const byId = new Map(lines.map((l) => [l.productId, l]));
  const ordered = [
    ...scanOrder.filter((id) => byId.has(id)),
    ...lines.map((l) => l.productId).filter((id) => !scanOrder.includes(id)),
  ];
  return ordered.map((id) => {
    const l = byId.get(id)!;
    return {
      id,
      name: l.productName,
      qty: returnLinePieces(l),
      qtySummary: qtySummary(l),
      subtotal: 0,
      unitsPerBox: packOf(l),
      unlisted: false,
    };
  });
}

/** A count as the line's raw input string: 0 is "" (nothing entered), as the editor shows it. */
const asInput = (n: number) => (n > 0 ? String(n) : "");

/**
 * The tray's typed qty (in pieces) onto the line; 0 or less removes it. SA-561: a BOXED line goes
 * back through the pack split (`normalizeBoxesPieces`), so "2 cs + 3" stepped once is "2 cs + 4",
 * never "52 pieces"; a non-boxed line stays plain pieces.
 */
export function setReturnLineQty(
  lines: readonly PrefilledReturnLine[],
  productId: string,
  qty: number,
): PrefilledReturnLine[] {
  if (!(qty > 0)) return lines.filter((l) => l.productId !== productId);
  return lines.map((l) => {
    if (l.productId !== productId) return l;
    const pack = packOf(l);
    if (!pack) return { ...l, boxes: "", pieces: String(Math.floor(qty)) };
    const split = normalizeBoxesPieces({ qty: Math.floor(qty), unitsPerBox: pack });
    return { ...l, boxes: asInput(split.boxes ?? 0), pieces: asInput(split.pieces ?? 0) };
  });
}

/** The tray's + / − stepper: one piece; taking the last piece removes the line. */
export function stepReturnLine(
  lines: readonly PrefilledReturnLine[],
  productId: string,
  delta: number,
): PrefilledReturnLine[] {
  const line = lines.find((l) => l.productId === productId);
  if (!line) return lines.slice();
  return setReturnLineQty(lines, productId, returnLinePieces(line) + delta);
}
