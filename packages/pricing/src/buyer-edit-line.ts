/**
 * B1395 (SA-1292): the ONE rule for a buyer EDIT-GRID row on a sent order: what one "+" step, one typed number and
 * the limit mean. Web (the portal order page) and mobile (customer edit-items) both call it; neither keeps a
 * `qty + 1`. Before this the grids stepped and typed PIECES: "+" on a stored 3-box line (12 a box, $18.00 a box)
 * sent 37 pieces and priced $55.50 instead of 48 and $72.00.
 *
 * A row counts in ONE unit, decided once from the stored row and kept for the whole edit session (a grid stores it
 * as `unit` at seed), so typing never flips a row between boxes and pieces:
 * - CASE: a named line with a stored split, whose stored pack equals the live pack (a whole number above 1) and
 *   whose qty is a positive multiple of it. The count is boxes; the qty is `count x unitsPerBox` PIECES.
 * - PIECE: a named split line that fails any of those (loose pieces, or repacked since). It counts pieces, so a
 *   row is never stepped at a pack the buyer did not sell it in.
 * - PACK: a named line stored in packs (no split), and every row added in this session. The count IS the qty
 *   (a plain qty on a new row counts packs, SA-601).
 *
 * The wire is unchanged: the grid still sends `{ productId, qty, orderItemId? }` and `qty` stays PIECES on a split
 * line; the server re-splits it at the live pack. Money stays `computeLineSubtotal`. Pure and display-free.
 */
import { packFromOwnSplit } from "./pricing";
import { pricedPerLabel } from "./priced-per-label";
import { BUYER_LINE_QTY_MAX } from "./unit-price-limit";
import { limitLine, maxLineCount } from "./unit-line-count";
import { plural } from "./unit-words";

export type EditRowUnit = "CASE" | "PIECE" | "PACK";

/** What either grid maps one of its rows into. Every field but `qty` may be absent. */
export interface EditRow {
  /** The stored line this row edits. Unset on a row added in this session. */
  orderItemId?: string | null;
  /** The wire quantity: PIECES on a split line, packs on a pack row. */
  qty: number;
  /** The stored split. Either one set means the line was stored box-aware. */
  boxes?: number | null;
  pieces?: number | null;
  /** The pack the LINE was sold in (its snapshot). Absent: read from its own split. */
  storedUnitsPerBox?: number | null;
  /** The product's pack TODAY; the server re-splits at this one. */
  unitsPerBox?: number | null;
  /** The unit decided at seed. When set it is honoured, so the unit never changes in an edit session. */
  unit?: EditRowUnit;
}

/** A whole pack size above 1, else 0. */
function wholePack(v: unknown): number {
  const n = v == null ? 0 : Number(v);
  return Number.isInteger(n) && n > 1 ? n : 0;
}

/** Decide a row's unit from its stored fields (the seed). Ignores `row.unit`. */
export function seedEditRowUnit(row: EditRow): EditRowUnit {
  if (!row.orderItemId) return "PACK";
  if (row.boxes == null && row.pieces == null) return "PACK";
  const live = wholePack(row.unitsPerBox);
  const stored = wholePack(row.storedUnitsPerBox) || (packFromOwnSplit(row) ?? 0);
  const qty = Number(row.qty);
  return live > 0 && stored === live && Number.isInteger(qty) && qty > 0 && qty % live === 0
    ? "CASE"
    : "PIECE";
}

/** The unit the row counts in: the one stored at seed when given, else decided from the row. */
export function editRowUnit(row: EditRow): EditRowUnit {
  return row.unit ?? seedEditRowUnit(row);
}

/** The count the grid shows: whole boxes on a CASE row, else the qty. */
export function editRowCount(row: EditRow): number {
  const live = wholePack(row.unitsPerBox);
  if (editRowUnit(row) === "CASE" && live > 0) return Math.trunc(Number(row.qty) / live);
  return Number(row.qty);
}

/** The most the row may count: its piece total stays within BUYER_LINE_QTY_MAX (8,333 boxes at 12 a box). */
export function editRowMax(row: EditRow): number {
  const unit = editRowUnit(row);
  const live = wholePack(row.unitsPerBox);
  return unit === "CASE" || (unit === "PACK" && live > 0)
    ? maxLineCount(BUYER_LINE_QTY_MAX, live)
    : BUYER_LINE_QTY_MAX;
}

/**
 * The new qty (the wire quantity) for a count in the row's unit: `count x unitsPerBox` PIECES on a CASE row, the
 * count itself otherwise. A whole count from 0 up to {@link editRowMax}; a caller decides what 0 means (web keeps
 * 1, mobile removes the row).
 */
export function setEditRowCount(row: EditRow, count: number): number {
  const n = Math.min(Math.max(0, Math.trunc(Number(count) || 0)), editRowMax(row));
  const live = wholePack(row.unitsPerBox);
  return editRowUnit(row) === "CASE" && live > 0 ? n * live : n;
}

/**
 * The limit sentence for this row, built at render time: "The most you can order at once is 8,333 boxes." The word
 * is the pack word `pricedPerLabel` gives the product, in lower-case plural; a row counting pieces ends at the number.
 */
export function editRowLimitLine(
  row: EditRow,
  product: {
    unit?: string | null;
    packLabel?: string | null;
    baseUnitLabel?: string | null;
  } = {},
): string {
  const live = wholePack(row.unitsPerBox);
  const unit = editRowUnit(row);
  const packs = live > 0 && (unit === "CASE" || unit === "PACK");
  const word = packs
    ? plural(pricedPerLabel({ ...product, unitsPerBox: live }).word.toLowerCase(), 2)
    : undefined;
  return limitLine(editRowMax(row), word);
}
