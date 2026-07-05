/**
 * Shared line-item subtotal calculation + money helpers.
 *
 * `pricePerUnit` on a Product is the canonical SELLING-UNIT price the operator
 * entered. For products with `unitsPerBox > 1` the canonical selling unit is
 * one BOX (because operators almost always quote and price by the case);
 * issuing loose pieces is prorated as `pricePerUnit / unitsPerBox`.
 *
 * Historically the codebase computed `subtotal = pricePerUnit * qty` where
 * `qty` was already expanded to total pieces (boxes × unitsPerBox + pieces).
 * That over-charged boxed items by a factor of `unitsPerBox` (a single $43.75
 * box of 6 came out as $262.50). This helper centralises the correct formula
 * so orders, invoices, estimates, vendor bills and the buyer cart all agree.
 *
 * MONEY DISCIPLINE: every monetary result returned from here is rounded to
 * cents via {@link roundMoney}. Callers MUST also wrap their own aggregations
 * (sum of lines, tax, grand total) in {@link roundMoney} so floating-point
 * drift never reaches the database. The web and mobile mirrors
 * (`apps/web/lib/pricing.ts`, `apps/mobile/lib/pricing.ts`) keep identical
 * copies of these helpers — change all three together.
 */

/**
 * Round a monetary amount to 2 decimal places (cents), guarding against binary
 * floating-point drift (e.g. `0.1 + 0.2`). This is the single rounding policy
 * for the whole money pipeline — half-away-from-zero at the cent.
 */
export function roundMoney(n: number): number {
  if (!Number.isFinite(n)) return 0;
  // Scale to cents, nudge by EPSILON so values like 4.005 round up reliably,
  // then round and scale back. Math.round is half-up for positive numbers.
  const sign = n < 0 ? -1 : 1;
  return (sign * Math.round((Math.abs(n) + Number.EPSILON) * 100)) / 100;
}

export interface NormalizedQty {
  /** Whole boxes (null for non-boxed products / no split). */
  boxes: number | null;
  /** Loose pieces below a full box (null for non-boxed products / no split). */
  pieces: number | null;
  /** Total quantity in pieces — always an integer. */
  qty: number;
}

/**
 * Force INTEGER boxes/pieces/qty and roll any loose pieces that reach a full
 * box up into the box count. Single source of truth for quantity hygiene so the
 * UI can never persist fractional units or a stale `pieces >= unitsPerBox`.
 *
 * - Boxed product (`unitsPerBox > 1`): derives a canonical `{boxes, pieces}`
 *   from whichever the caller supplied — an explicit boxes/pieces split OR a
 *   raw piece `qty` — and guarantees `pieces < unitsPerBox`.
 * - Non-boxed product: returns `{boxes: null, pieces: null, qty}` with `qty`
 *   coerced to a non-negative integer.
 */
export function normalizeBoxesPieces(input: {
  boxes?: number | null;
  pieces?: number | null;
  qty?: number | null;
  unitsPerBox?: number | null;
}): NormalizedQty {
  const upb = Math.trunc(Number(input.unitsPerBox ?? 0));
  const hasBoxPackaging = upb > 1;

  if (hasBoxPackaging) {
    const splitProvided = input.boxes != null || input.pieces != null;
    const totalPieces = splitProvided
      ? Math.trunc(Number(input.boxes ?? 0)) * upb + Math.trunc(Number(input.pieces ?? 0))
      : Math.trunc(Number(input.qty ?? 0));
    const safeTotal = Math.max(0, totalPieces);
    return {
      boxes: Math.floor(safeTotal / upb),
      pieces: safeTotal % upb,
      qty: safeTotal,
    };
  }

  const qty = Math.max(0, Math.trunc(Number(input.qty ?? 0)));
  return { boxes: null, pieces: null, qty };
}

export interface LineSubtotalInput {
  unitPrice: number;
  /** Total qty in pieces — kept for backward compat & non-boxed products. */
  qty: number;
  /** Number of full boxes (only meaningful when unitsPerBox > 1). */
  boxes?: number | null;
  /** Loose pieces below a full box. */
  pieces?: number | null;
  /** Box size; null/1 means the product is sold as individual pieces. */
  unitsPerBox?: number | null;
}

export function computeLineSubtotal(input: LineSubtotalInput): number {
  const { unitPrice, qty, boxes, pieces, unitsPerBox } = input;
  const upb = Number(unitsPerBox ?? 0);
  const hasBoxPackaging = upb > 1;
  const boxesPiecesProvided = boxes != null || pieces != null;

  if (hasBoxPackaging && boxesPiecesProvided) {
    // unitPrice is the BOX price. One box = unitPrice; loose pieces are prorated.
    const b = Number(boxes ?? 0);
    const p = Number(pieces ?? 0);
    const boxEquivalent = b + p / upb;
    return roundMoney(unitPrice * boxEquivalent);
  }

  // Non-boxed product (or caller didn't split): unitPrice is per piece, qty in pieces.
  return roundMoney(unitPrice * qty);
}

// ─── Margin: the "negotiation floor" (pos-cost-roles-spec §1) ─────────────────
// `unitCost` (Product.averageCost) is per PIECE. `unitPrice` is per SELLING UNIT
// (a BOX when unitsPerBox > 1, else a piece). Bring cost onto the selling-unit
// basis before comparing, or margins are wrong by a factor of unitsPerBox — the
// same class of bug the box-proration fix guards. Keep all three mirrors in sync.

/** Cost of one selling unit: piece cost × unitsPerBox for boxed products, else the piece cost. */
export function costPerSellingUnit(unitCost: number, unitsPerBox?: number | null): number {
  const upb = Number(unitsPerBox ?? 0);
  return upb > 1 ? Number(unitCost) * upb : Number(unitCost);
}

/** Gross margin fraction on a line: (price − cost) / price. null when price ≤ 0 or cost unknown. */
export function computeMarginFraction(
  unitPrice: number,
  unitCost: number | null | undefined,
  unitsPerBox?: number | null,
): number | null {
  if (unitCost == null || !Number.isFinite(Number(unitCost))) return null;
  const price = Number(unitPrice);
  if (!(price > 0)) return null;
  const cost = costPerSellingUnit(Number(unitCost), unitsPerBox);
  return (price - cost) / price;
}

/** The selling-unit price that yields exactly `floor` margin for the given piece cost. */
export function priceForMarginFloor(
  unitCost: number,
  floor: number,
  unitsPerBox?: number | null,
): number {
  const cost = costPerSellingUnit(Number(unitCost), unitsPerBox);
  const f = Math.min(Math.max(Number(floor) || 0, 0), 0.99); // margin must stay < 1
  return roundMoney(cost / (1 - f));
}

export type MarginClass = "ok" | "warn" | "belowFloor" | "belowCost";

/**
 * Classify a margin fraction against a floor:
 * `belowCost` (< 0) · `belowFloor` (< floor) · `warn` (within 5 points above floor) · `ok`.
 * Returns null when margin is unknown (no cost).
 */
export function classifyMargin(margin: number | null, floor: number): MarginClass | null {
  if (margin == null) return null;
  if (margin < 0) return "belowCost";
  if (margin < floor) return "belowFloor";
  if (margin < floor + 0.05) return "warn";
  return "ok";
}
