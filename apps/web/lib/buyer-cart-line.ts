import { normalizeBoxesPieces, plural, unitLineCount } from "@routeflow/pricing";

/**
 * The ONE place a buyer cart line's quantity is computed (row 531, the "2 each = 1 box" P0).
 *
 * A boxed product (`unitsPerBox > 1`) is stored on a cart line as `qty` (PIECES) plus the split
 * `boxes` / `pieces`, and the invariant is `qty === boxes * unitsPerBox + pieces` after EVERY
 * mutation. The server prefers the split over `qty`, so a line whose two halves disagree is billed
 * at the split while the row shows `qty` (a 12x error in one direction, the buyer's trust in the
 * other). Nothing here re-derives money: the split always comes from `normalizeBoxesPieces`, and
 * the cart / server price the split with `computeLineSubtotal`.
 *
 * The stepper counts the line's SELLING UNIT and always shows it: a boxed line defaults to CASE
 * (Add writes one box, typing 2 means 2 Cases), and a visible Case / Each toggle switches the
 * stepper and its label together. `qty` stays in pieces either way, so the toggle never moves the
 * money. A non-boxed product has one unit and no split.
 */

export type CartUnit = "CASE" | "EACH";

export const CASE_LABEL = "Case";
export const EACH_LABEL = "Each";

/** The fixed buyer-facing sentence for a coded QTY_SPLIT_MISMATCH 400 (nothing was saved). */
export const BUYER_QTY_SPLIT_MISMATCH_COPY =
  "Your cart changed. Review the quantities and try again.";

export interface CartLineShape {
  qty: number;
  unitsPerBox?: number | null;
  boxes?: number | null;
  pieces?: number | null;
  /** The unit the stepper counts in. Absent on a line stored before this field existed. */
  sellBy?: CartUnit;
}

/** Whole pack size of a boxed line, else 0. */
function packOf(l: { unitsPerBox?: number | null }): number {
  const upb = Math.trunc(Number(l.unitsPerBox ?? 0));
  return upb > 1 ? upb : 0;
}

/** True when the line is a boxed product (pack size > 1). */
export function isBoxedLine(l: { unitsPerBox?: number | null }): boolean {
  return packOf(l) > 0;
}

/** True when the line's stored halves agree: a boxed line's `qty` equals `boxes * pack + pieces`. */
export function isLineConsistent(l: CartLineShape): boolean {
  const upb = packOf(l);
  if (upb === 0) return true;
  return (
    Number.isInteger(l.qty) &&
    l.boxes != null &&
    l.pieces != null &&
    l.pieces >= 0 &&
    l.pieces < upb &&
    l.boxes * upb + l.pieces === l.qty
  );
}

/**
 * The unit a line's stepper counts in. A stored `sellBy` wins when the line can honour it (a CASE
 * line holds whole Cases only); otherwise a whole-Case line reads as CASE and anything with loose
 * pieces as EACH. A non-boxed line has no Case, so it reads EACH (the product's own unit).
 */
export function lineUnit(l: CartLineShape): CartUnit {
  const upb = packOf(l);
  if (upb === 0) return "EACH";
  const wholeCases = Number.isInteger(l.qty) && l.qty > 0 && l.qty % upb === 0;
  if (l.sellBy === "EACH") return "EACH";
  if (l.sellBy === "CASE") return wholeCases ? "CASE" : "EACH";
  return wholeCases ? "CASE" : "EACH";
}

/** The count the stepper shows: whole Cases for a CASE line, pieces otherwise. */
export function lineCount(l: CartLineShape): number {
  const upb = packOf(l);
  if (upb > 0 && lineUnit(l) === "CASE") {
    // The ONE Case-count function (#2276 / SA-388): `boxes` when stored, else qty / pack.
    const n = normalizeBoxesPieces({ qty: l.qty, unitsPerBox: upb });
    return unitLineCount({ qty: n.qty, boxes: n.boxes, unitsPerBox: upb }) ?? 0;
  }
  return l.qty;
}

/**
 * Rebuild a line from its `qty` (the buyer's last edit; the split is always derived, never kept).
 * Boxed: `{ qty, boxes, pieces }` from `normalizeBoxesPieces`, pieces < pack. Non-boxed: the split
 * keys are dropped. `sellBy` is resolved by {@link lineUnit} so a line never claims a unit it
 * cannot honour.
 */
export function normalizeCartLine<T extends CartLineShape>(l: T): T {
  const upb = packOf(l);
  if (upb === 0) {
    const { boxes: _b, pieces: _p, sellBy: _s, ...rest } = l;
    void _b;
    void _p;
    void _s;
    const n = normalizeBoxesPieces({ qty: l.qty, unitsPerBox: null });
    return { ...rest, qty: n.qty } as T;
  }
  const n = normalizeBoxesPieces({ qty: l.qty, unitsPerBox: upb });
  const next = {
    ...l,
    unitsPerBox: upb,
    qty: n.qty,
    boxes: n.boxes ?? 0,
    pieces: n.pieces ?? 0,
  };
  return { ...next, sellBy: lineUnit(next) };
}

/** Set the count in the line's CURRENT unit (what the stepper and its typed field mean). */
export function setLineCount<T extends CartLineShape>(l: T, count: number): T {
  const n = Math.max(0, Math.trunc(Number(count) || 0));
  const upb = packOf(l);
  if (upb > 0 && lineUnit(l) === "CASE") {
    return normalizeCartLine({ ...l, sellBy: "CASE" as const, qty: n * upb });
  }
  return normalizeCartLine({ ...l, qty: n });
}

/** True when a line may switch to CASE: it holds no loose pieces, so no money would move. */
export function canSellByCase(l: CartLineShape): boolean {
  const upb = packOf(l);
  return upb > 0 && Number.isInteger(l.qty) && l.qty > 0 && l.qty % upb === 0;
}

/** Switch the stepper's unit. `qty` (pieces) never changes, so neither does the subtotal. */
export function setLineUnit<T extends CartLineShape>(l: T, unit: CartUnit): T {
  if (packOf(l) === 0) return l;
  if (unit === "CASE" && !canSellByCase(l)) return normalizeCartLine({ ...l, sellBy: "EACH" });
  return normalizeCartLine({ ...l, sellBy: unit });
}

/**
 * Hydrate a line read back from storage. A mismatched line is rebuilt FROM `qty` (the last edit),
 * read as PIECES: the old rows labelled it "= N each" (cart) and showed the bare qty beside
 * "per each (N/box)" (shop tile), so the number the buyer saw was a piece count. A rebuilt line
 * with whole Cases and no loose pieces reads as CASE (same quantity, same money), else EACH.
 */
export function hydrateCartLine<T extends CartLineShape>(l: T): T {
  if (!Number.isFinite(Number(l.qty)) || Number(l.qty) <= 0) return l;
  return normalizeCartLine(l);
}

/**
 * Complete a line that was stored without its pack size (an older Add from favorites / dashboard
 * wrote `{ qty: 1 }` with no `unitsPerBox`) once the catalog says the product is boxed. A bare qty
 * on every buyer path counts SELLING UNITS (the server bills `qty x BOX price`), so the old qty is
 * a Case count: `qty` Cases, the amount the order would have billed.
 */
export function completeLineFromCatalog<T extends CartLineShape>(
  l: T,
  catalogUnitsPerBox: number | null | undefined,
): T {
  if (isBoxedLine(l)) return l;
  const upb = Math.trunc(Number(catalogUnitsPerBox ?? 0));
  if (!(upb > 1)) return l;
  const cases = Math.max(1, Math.trunc(Number(l.qty) || 0));
  return normalizeCartLine({ ...l, unitsPerBox: upb, sellBy: "CASE" as const, qty: cases * upb });
}

/**
 * The line Add writes: one Case (one box) of a boxed product, one piece of any other. `boxes` and
 * `pieces` are present only for a boxed product, so a plain product's payload carries `qty` alone.
 */
export function newCartLine<
  P extends { productId: string; name: string; unit: string; thumbnailUrl?: string | null },
>(p: P, unitsPerBox: number | null | undefined, cases = 1): P & CartLineShape {
  const upb = Math.trunc(Number(unitsPerBox ?? 0));
  if (!(upb > 1))
    return { ...p, qty: Math.max(1, Math.trunc(cases)), unitsPerBox: unitsPerBox ?? null };
  return normalizeCartLine<P & CartLineShape>({
    ...p,
    unitsPerBox: upb,
    sellBy: "CASE",
    qty: Math.max(1, Math.trunc(cases)) * upb,
  });
}

/** "2 Cases (24 ea)" | "24 Each (2 Cases)" | "15 Each (1 Case + 3 ea)" | "" for a non-boxed line. */
export function lineQtyText(l: CartLineShape): string {
  const upb = packOf(l);
  if (upb === 0) return "";
  const n = normalizeBoxesPieces({ qty: l.qty, unitsPerBox: upb });
  const boxes = n.boxes ?? 0;
  const pieces = n.pieces ?? 0;
  if (lineUnit(l) === "CASE") return `${boxes} ${plural(CASE_LABEL, boxes)} (${n.qty} ea)`;
  const cases =
    boxes > 0
      ? ` (${boxes} ${plural(CASE_LABEL, boxes)}${pieces > 0 ? ` + ${pieces} ea` : ""})`
      : "";
  return `${n.qty} ${EACH_LABEL}${cases}`;
}

/** The unit word beside the stepper: "Cases" / "Case" for a CASE line, "Each" for pieces. */
export function lineUnitWord(l: CartLineShape): string {
  if (packOf(l) > 0 && lineUnit(l) === "CASE") return plural(CASE_LABEL, lineCount(l));
  return EACH_LABEL;
}

/**
 * The `items` array checkout sends (POST /buyer/orders): `{ productId, qty }` for a plain product,
 * plus `boxes` / `pieces` for a boxed one. Each line is re-normalised on the way out, so the
 * payload agrees with itself (`qty === boxes * pack + pieces`) even if a stale line slipped into
 * state; the server answers a disagreeing payload with a coded 400 (QTY_SPLIT_MISMATCH).
 */
export function cartOrderItems<T extends CartLineShape & { productId: string }>(
  items: readonly T[],
): Array<{ productId: string; qty: number; boxes?: number; pieces?: number }> {
  return items.map((raw) => {
    const l = normalizeCartLine(raw);
    return isBoxedLine(l)
      ? { productId: l.productId, qty: l.qty, boxes: l.boxes ?? 0, pieces: l.pieces ?? 0 }
      : { productId: l.productId, qty: l.qty };
  });
}
