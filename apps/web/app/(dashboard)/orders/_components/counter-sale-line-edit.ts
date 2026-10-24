import {
  normalizeBoxesPieces,
  perUnitPrice,
  plural,
  unitWords,
  type UnitWords,
} from "@routeflow/pricing";
import type { CounterSaleItem } from "@routeflow/types";
import { lineCount, lineUnit, type CartUnit } from "@/lib/buyer-cart-line";
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

/** The words a line reads in: the PRODUCT's pack word when it has one, else the tenant's (`words`). */
export const lineUnitWords = (l: SaleLine, words: UnitWords): UnitWords =>
  l.packLabel?.trim() ? unitWords({ packLabel: l.packLabel }) : words;

/**
 * The register line's quantity: `lineQtyLabel`'s shape in the pack word (`unitWords`), then the pack size. A boxed line
 * with whole boxes only reads "1 case of 24"; with loose pieces "1 case + 3 pcs · case of 24" (so the pack is always named).
 * The receipt keeps `lineQtyLabel` unchanged. Money is never derived here.
 */
export const registerQtyLabel = (l: SaleLine, tenantWords: UnitWords): string => {
  if (!isBoxedLine(l)) return `× ${l.qty}`;
  const words = lineUnitWords(l, tenantWords);
  const n = normalizeBoxesPieces({
    boxes: l.boxes,
    pieces: l.pieces,
    qty: l.qty,
    unitsPerBox: l.unitsPerBox,
  });
  const boxes = n.boxes ?? 0;
  const pack = words.packFor(boxes);
  const size = l.unitsPerBox;
  if (!n.pieces) return `${boxes} ${pack} of ${size}`;
  return `${boxes} ${pack} + ${n.pieces} ${words.base.short.other} · ${words.pack.lower} of ${size}`;
};

/** The register line's price: per pack, then the per-piece figure (`perUnitPrice`); a plain line per its unit word. */
export const registerPriceLabel = (
  l: SaleLine,
  tenantWords: UnitWords,
  money: (n: number) => string,
  unitWord: (unit: string) => string,
): string => {
  const words = lineUnitWords(l, tenantWords);
  if (!isBoxedLine(l))
    return `${money(l.unitPrice)} / ${l.unit ? unitWord(l.unit) : words.base.lower}`;
  const each = perUnitPrice(l.unitPrice, l.unitsPerBox);
  return `${money(l.unitPrice)} / ${words.pack.lower}${each != null ? ` · ${money(each)} each` : ""}`;
};

/**
 * Row 676 (SA-831b M13, the row-531 rule on a counter line): the ONE stepper counts the line's SELLING UNIT. These are thin
 * adapters over `lib/buyer-cart-line` (`lineUnit` / `lineCount`, the one rule), reading the line through
 * `normalizeBoxesPieces` so a stored split that does not add up still counts what the receipt would bill. A whole-case line
 * defaults to CASE, one holding loose pieces to EACH, and a chosen CASE is honoured only when no piece is loose. Nothing here
 * changes a stored qty/boxes/pieces: stepping and typing still go through `stepLine` / `setLineQty`.
 */
const unitShape = (l: SaleLine, chosen?: CartUnit) => {
  const n = normalizeBoxesPieces({
    boxes: l.boxes,
    pieces: l.pieces,
    qty: l.qty,
    unitsPerBox: l.unitsPerBox,
  });
  return { qty: n.qty, unitsPerBox: l.unitsPerBox, sellBy: chosen };
};

export const lineSellUnit = (l: SaleLine, chosen?: CartUnit): CartUnit =>
  isBoxedLine(l) ? lineUnit(unitShape(l, chosen)) : "EACH";

/** The count the stepper shows: whole cases in CASE, pieces (a plain line's qty) in EACH. */
export const lineSellCount = (l: SaleLine, unit: CartUnit): number =>
  isBoxedLine(l) && unit === "CASE" ? lineCount(unitShape(l, "CASE")) : unitShape(l).qty;

/** True when a boxed line may switch to CASE: no loose pieces, so the count stays exact. */
export const canSellByCase = (l: SaleLine): boolean =>
  isBoxedLine(l) && lineUnit(unitShape(l, "CASE")) === "CASE";

/** The always-visible unit word beside the count: "boxes" / "cases" (the pack word), "each", or a plain line's own unit. */
export const sellUnitWord = (
  l: SaleLine,
  unit: CartUnit,
  count: number,
  tenantWords: UnitWords,
): string => {
  const words = lineUnitWords(l, tenantWords);
  if (isBoxedLine(l)) return unit === "CASE" ? words.packFor(count) : "each";
  const own = (l.unit ?? "").trim().toLowerCase();
  if (!own) return words.baseFor(count);
  return own === "each" ? own : plural(own, count).toLowerCase();
};

/** What the typed count means in the chosen unit, as the editor's raw boxes + pieces (a plain line: its qty). */
export const typedForSellUnit = (l: SaleLine, unit: CartUnit, text: string): TypedQty =>
  !isBoxedLine(l)
    ? { qty: text }
    : unit === "CASE"
      ? { boxes: text, pieces: "0" }
      : { boxes: "0", pieces: text };

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
  // POS-5: ONLY an edited line carries a price. `unitPrice` is the already-rounded NET price; every other line is
  // byte-identical to what the till always sent (the server prices it).
  const reason = l.override?.reason?.trim();
  return {
    ...(n.boxes === null || n.pieces === null
      ? { productId: l.productId, qty: n.qty }
      : { productId: l.productId, boxes: n.boxes, pieces: n.pieces, qty: n.qty }),
    ...(l.override ? { unitPrice: l.unitPrice, ...(reason ? { priceReason: reason } : {}) } : {}),
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

/** What the typed quantity editor hands over: the raw field text(s). */
export interface TypedQty {
  qty?: string;
  boxes?: string;
  pieces?: string;
}

const WHOLE = /^\d+$/;

/**
 * The line after a TYPED quantity, or null when the text is not a usable quantity (the editor then reverts; removal stays the
 * x button). A plain line takes a whole qty >= 1. A boxed line takes whole boxes and pieces (>= 0, at least one piece in
 * total), flattened and re-split through `normalizeBoxesPieces` so pieces < unitsPerBox - the same split a stepper makes.
 */
export function setLineQty(l: SaleLine, typed: TypedQty): SaleLine | null {
  if (isBoxedLine(l)) {
    const upb = l.unitsPerBox ?? 0;
    const b = (typed.boxes ?? String(l.boxes ?? 0)).trim();
    const p = (typed.pieces ?? String(l.pieces ?? 0)).trim();
    if (!WHOLE.test(b) || !WHOLE.test(p)) return null;
    const total = Number(b) * upb + Number(p);
    if (!Number.isSafeInteger(total) || total < 1) return null;
    const norm = normalizeBoxesPieces({ qty: total, unitsPerBox: upb });
    return { ...l, boxes: norm.boxes ?? 0, pieces: norm.pieces ?? 0, qty: norm.qty };
  }
  const q = (typed.qty ?? String(l.qty)).trim();
  if (!WHOLE.test(q)) return null;
  const n = Number(q);
  return Number.isSafeInteger(n) && n >= 1 ? { ...l, qty: n } : null;
}
