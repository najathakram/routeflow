import { ConflictException } from "@nestjs/common";
import { round4 } from "@routeflow/pricing";
import { API_ERROR_CODES } from "../common/api-error-codes";

/**
 * SA-946 / W-867: the ONE pack-introduction rule. Stock is kept in pieces (B703) and cost per piece
 * (pricing.ts), but a product sold with no pack stores whatever the business entered. When a pack of
 * N > 1 arrives on such a product, the "box" reading says the thing sold so far was a box of N, so the
 * per-piece numbers are rescaled: stock, reorder levels and open cost lots x N, cost / N. The "piece"
 * reading (every import, SA-961 R1) changes nothing. Prices are never touched (L-332). Pure: no I/O.
 */
export type PackReading = "box" | "piece";
export const PACK_READINGS = ["box", "piece"] as const;

/** Largest value a Decimal(10,3) column holds, and the Int4 ceiling the reorder columns share. */
const MAX_DECIMAL_10_3 = 9_999_999.999;
const MAX_INT4 = 2_147_483_647;

type Num = number | string | { toString(): string } | null | undefined;
export interface PackIntroLot {
  id: string;
  qty: Num;
  remainingQty: Num;
  unitCost: Num;
}
export interface PackIntroProduct {
  unitsPerBox?: number | null;
  currentStock?: Num;
  reorderPoint?: number | null;
  reorderQty?: number | null;
  averageCost?: Num;
  standardCost?: Num;
  /** The product's open lots (remainingQty above zero); a used-up lot is never rewritten. */
  stockLots?: PackIntroLot[];
}
export interface PackIntroLotChange {
  id: string;
  qty: number;
  remainingQty: number;
  unitCost: number;
}
/** A column the scaled value no longer fits; the caller refuses the save instead of clamping. */
export type PackIntroField = "currentStock" | "reorderPoint" | "reorderQty" | "lotQty";
export interface PackIntroChanges {
  product: {
    currentStock?: number;
    reorderPoint?: number;
    reorderQty?: number;
    averageCost?: number;
    standardCost?: number;
  };
  lots: PackIntroLotChange[];
  overflow: PackIntroField[];
}

const num = (v: Num): number | null => (v == null ? null : Number(v));
const round3 = (n: number) => Number(n.toFixed(3));

/** A pack goes from blank (or 1, which behaves as blank) to N > 1. Anything else is an editor-only change. */
export function isPackIntroduction(
  stored: number | null | undefined,
  n: number | null | undefined,
) {
  return Number.isInteger(n) && (n as number) > 1 && (stored == null || stored <= 1);
}

/** Stock, a cost, or an open lot is held: the cases that need an answer to "boxes or pieces" (SA-961 R1). */
export function holdsStockOrCost(p: PackIntroProduct): boolean {
  const nonZero = (v: Num) => num(v) != null && num(v) !== 0;
  return (
    nonZero(p.currentStock) ||
    nonZero(p.averageCost) ||
    nonZero(p.standardCost) ||
    (p.stockLots ?? []).some((l) => nonZero(l.remainingQty))
  );
}

/**
 * The changes a pack of `n` makes to a product's per-piece numbers, or null when nothing converts
 * (a "piece" reading, a pack that is not an introduction). Cost rounds at Decimal(10,4), stock at 3 dp.
 * A result below zero is allowed (SA-958: warned, never blocked).
 */
export function packIntroChanges(
  product: PackIntroProduct,
  n: number,
  reading: PackReading,
): PackIntroChanges | null {
  if (reading !== "box" || !isPackIntroduction(product.unitsPerBox, n)) return null;
  const overflow: PackIntroField[] = [];
  const out: PackIntroChanges = { product: {}, lots: [], overflow };

  const stock = num(product.currentStock);
  if (stock != null) {
    out.product.currentStock = round3(stock * n);
    if (Math.abs(out.product.currentStock) > MAX_DECIMAL_10_3) overflow.push("currentStock");
  }
  for (const k of ["reorderPoint", "reorderQty"] as const) {
    const v = product[k];
    if (v == null) continue;
    out.product[k] = v * n;
    if (out.product[k]! > MAX_INT4) overflow.push(k);
  }
  for (const k of ["averageCost", "standardCost"] as const) {
    const v = num(product[k]);
    if (v != null) out.product[k] = round4(v / n);
  }
  for (const lot of product.stockLots ?? []) {
    const remaining = num(lot.remainingQty) ?? 0;
    if (remaining <= 0) continue;
    const change = {
      id: lot.id,
      qty: round3((num(lot.qty) ?? 0) * n),
      remainingQty: round3(remaining * n),
      unitCost: round4((num(lot.unitCost) ?? 0) / n),
    };
    if (Math.max(change.qty, change.remainingQty) > MAX_DECIMAL_10_3) overflow.push("lotQty");
    out.lots.push(change);
  }
  return out;
}

/** 409: the save introduces a pack on a product that holds stock or cost and does not say what the stock number meant. */
export function packReadingRequiredError(): ConflictException {
  return new ConflictException({
    code: API_ERROR_CODES.PACK_READING_REQUIRED,
    message: "This product holds stock or cost. Say whether its stock number is boxes or pieces.",
  });
}

/** 409: the box answer doesn't fit a column. Never clamped. */
export function packConversionTooLargeError(): ConflictException {
  return new ConflictException({
    code: API_ERROR_CODES.PACK_CONVERSION_TOO_LARGE,
    message: "That many pieces won't fit. Choose Pieces, or use a smaller pack size.",
  });
}

/**
 * L-305 inventory pin: one decision for every numeric Product / StockLot column (pack-intro.pin.spec.ts
 * goes red on a column without one). "scale-up" / "scale-down" are exactly the columns packIntroChanges writes.
 */
export type PackIntroDecision = "scale-up" | "scale-down" | "price" | "pack" | "other";
export const PACK_INTRO_DECISIONS: Record<string, { decision: PackIntroDecision; why: string }> = {
  "Product.currentStock": {
    decision: "scale-up",
    why: "Stock is kept in pieces (B703); a box of N is N pieces.",
  },
  "Product.reorderPoint": {
    decision: "scale-up",
    why: "Compared with currentStock (needsReorder), so the same unit.",
  },
  "Product.reorderQty": {
    decision: "scale-up",
    why: "A quantity to order, in the same unit as stock.",
  },
  "Product.averageCost": {
    decision: "scale-down",
    why: "Cost is per piece (pricing.ts); a box cost is N pieces' cost.",
  },
  "Product.standardCost": { decision: "scale-down", why: "Per-piece cost, like averageCost." },
  "StockLot.qty": {
    decision: "scale-up",
    why: "Lot quantity in pieces, kept equal to the stock it feeds.",
  },
  "StockLot.remainingQty": {
    decision: "scale-up",
    why: "Open lot quantity in pieces; FIFO draws from it.",
  },
  "StockLot.unitCost": { decision: "scale-down", why: "Per-piece lot cost, like averageCost." },
  "Product.unitsPerBox": {
    decision: "pack",
    why: "The pack itself: the very value being introduced.",
  },
  "Product.pricePerUnit": {
    decision: "price",
    why: "A price: a qty-only line prices the same at N as at blank (L-332).",
  },
  "Product.priceTier2": {
    decision: "price",
    why: "A price tier: never re-priced by a pack (L-332).",
  },
  "Product.priceTier3": {
    decision: "price",
    why: "A price tier: never re-priced by a pack (L-332).",
  },
  "Product.priceTier4": {
    decision: "price",
    why: "A price tier: never re-priced by a pack (L-332).",
  },
  "Product.priceTier5": {
    decision: "price",
    why: "A price tier: never re-priced by a pack (L-332).",
  },
  "Product.msrp": {
    decision: "price",
    why: "A price: the per-piece MSRP is derived at read time (common/msrp.ts).",
  },
  "Product.flexStep": {
    decision: "other",
    why: "Step of a flexible-quantity ladder, a selling rule not a stock figure.",
  },
  "Product.packAuto": {
    decision: "other",
    why: "A counter of automatic pack fills, not a quantity or a cost.",
  },
  "Product.priceRevision": {
    decision: "other",
    why: "An optimistic-lock counter on the price ladder.",
  },
};
