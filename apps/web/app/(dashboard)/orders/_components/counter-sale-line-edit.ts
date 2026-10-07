import { normalizeBoxesPieces } from "@routeflow/pricing";
import type { CounterSaleItem } from "@routeflow/types";
import { mergePieceIntoLine } from "./add-line-merge";
import type { SaleLine } from "./counter-sale-scan";

/**
 * Pure line logic of the counter cart row: what a line reads as, and the wire item it sends. Money is never derived here
 * (the screen prices through cartTotals -> @routeflow/pricing).
 */

/** A pack of 1 (or no pack) has no box/piece split: it reads in pieces. Only unitsPerBox > 1 is a boxed line. */
export const isBoxedLine = (l: SaleLine) => (l.unitsPerBox ?? 0) > 1;

/** ONE quantity label for the cart and the receipt: whole boxes, then loose pieces; a plain line reads "× qty". */
export const lineQtyLabel = (l: SaleLine): string => {
  if (!isBoxedLine(l)) return `× ${l.qty}`;
  // Always the normalized split (pieces < pack), so a stored 0 boxes + 30 pcs on a 24-pack still reads "1 box + 6 pcs".
  const n = normalizeBoxesPieces({
    boxes: l.boxes,
    pieces: l.pieces,
    qty: l.qty,
    unitsPerBox: l.unitsPerBox,
  });
  const boxes = n.boxes ?? 0;
  return `${boxes} box${boxes === 1 ? "" : "es"}${n.pieces ? ` + ${n.pieces} pcs` : ""}`;
};

/**
 * The wire item for one line, shaped the way the server's normaliser reads it (`normalizeBoxesPieces`): a boxed product
 * (unitsPerBox > 1) sends `{boxes, pieces, qty}` with `qty` the integer piece count; anything else (no pack, or a pack of 1,
 * which has no box/piece split) sends `qty` alone. Boxes without a qty is what the server reads as 0.
 */
export const toSaleItem = (l: SaleLine): CounterSaleItem => {
  const n = normalizeBoxesPieces({
    boxes: l.boxes,
    pieces: l.pieces,
    qty: l.qty,
    unitsPerBox: l.unitsPerBox,
  });
  const note = l.note?.trim();
  return {
    ...(n.boxes === null || n.pieces === null
      ? { productId: l.productId, qty: n.qty }
      : { productId: l.productId, boxes: n.boxes, pieces: n.pieces, qty: n.qty }),
    ...(note ? { note } : {}),
  };
};

/** The longest per-line note (mirrors the API DTO's MaxLength). */
export const NOTE_MAX = 200;

export const setLineNote = (lines: SaleLine[], tempId: string, note: string): SaleLine[] =>
  lines.map((l) => {
    if (l.tempId !== tempId) return l;
    const { note: _drop, ...rest } = l;
    return note.trim() ? { ...rest, note: note.slice(0, NOTE_MAX) } : rest; // an empty note is no note
  });

/** A removed line with the index it sat at, held for the 5 s Undo. */
export interface RemovedLine {
  line: SaleLine;
  index: number;
}

export function takeLine(
  lines: SaleLine[],
  tempId: string,
): { lines: SaleLine[]; removed: RemovedLine } | null {
  const index = lines.findIndex((l) => l.tempId === tempId);
  if (index < 0) return null;
  return { lines: lines.filter((_, i) => i !== index), removed: { line: lines[index], index } };
}

/** Whole pieces a line holds (a boxed line's split flattened; a plain line's qty). */
const piecesIn = (l: SaleLine): number =>
  isBoxedLine(l) ? (l.boxes ?? 0) * (l.unitsPerBox ?? 0) + (l.pieces ?? 0) : l.qty;

/**
 * Undo: the line goes back at its index with its qty, boxes/pieces, price and note untouched. If the SAME product was
 * re-scanned meanwhile, its quantity is added to that line instead (one line per product, as a scan merges), and a note
 * on both is joined, never dropped.
 */
export function restoreLine(lines: SaleLine[], { line, index }: RemovedLine): SaleLine[] {
  const twin = lines.findIndex((l) => l.productId === line.productId);
  if (twin < 0) {
    const at = Math.min(index, lines.length);
    return [...lines.slice(0, at), line, ...lines.slice(at)];
  }
  return lines.map((l, i) => {
    if (i !== twin) return l;
    const merged = mergePieceIntoLine(l, piecesIn(line));
    const notes = [l.note, line.note].filter((n): n is string => !!n?.trim());
    return notes.length
      ? { ...merged, note: [...new Set(notes)].join(" / ").slice(0, NOTE_MAX) }
      : merged;
  });
}
