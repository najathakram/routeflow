import type { AdjustmentReason } from "./enums";

/**
 * SA-828 (row 657) + SA-828a: `POST /inventory/products/:id/count` — set the stock to a count, or adjust it
 * by a delta, entered as parts in the product's units ("3 cases + 4 boxes"). The SERVER resolves every
 * part's factor from the product's ladder (never a client factor) and refuses a fractional count of a
 * packed unit (400 COUNT_FRACTIONAL_PACK) and a unit named twice (400 COUNT_DUPLICATE_UNIT).
 * `unit`: a ladder label ("Case", "Piece"); null / "" = the product's own pack.
 */
export interface ProductCountQuantity {
  unit?: string | null;
  /** >= 0; whole for a packed unit. */
  quantity: number;
}

export type ProductCountRequest = (
  | { mode: "SET"; parts: ProductCountQuantity[] }
  /** One sign for the whole delta; the parts stay non-negative. */
  | { mode: "ADJUST"; parts: ProductCountQuantity[]; sign: "+" | "-" }
) & {
  reason: AdjustmentReason;
  /** Required (3-200 characters) when `reason` is OTHER. */
  reasonNote?: string;
  /** ISO date; default now. A future date is 400; a date in a filed period is 409. */
  effectiveDate?: string;
};

export interface ProductCountResult {
  productId: string;
  mode: "SET" | "ADJUST";
  /** The signed change in pieces actually written (0 when a SET matched the stock). */
  deltaPieces: number;
  stockBefore: number;
  stockAfter: number;
  /** Null when nothing was written (a SET equal to the current stock). */
  movementId: string | null;
}

/** Labels shared by web and mobile, in picker order. */
export const ADJUSTMENT_REASON_LABELS: Record<AdjustmentReason, string> = {
  COUNT_CORRECTION: "Count correction",
  DAMAGED: "Damaged",
  EXPIRED: "Expired",
  THEFT: "Theft or loss",
  SAMPLE: "Sample",
  OTHER: "Other",
};

/** OTHER needs a note of this length (SA-804(3)). */
export const ADJUSTMENT_REASON_NOTE_MIN = 3;
export const ADJUSTMENT_REASON_NOTE_MAX = 200;
