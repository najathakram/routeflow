import { BadRequestException } from "@nestjs/common";
import { billableQtyFromBasis, type DeliveredBasis } from "../invoices/delivered-basis-by-line";

/**
 * SA-1514 (Amendment 3) R1 + SA-1520 (Amendment 4) M-1: the ONE corrected delivered figure, D', of a CORRECT line. Every
 * basis (NONE, OFFICE and, in PR-1c, ROUTE) reads this function, so the column, the evidence rows and the stock settle never
 * disagree.
 *
 * First match wins:
 *  0. a take-off (the line struck) delivers 0.
 *  1. the entry's `deliveredTo`, when sent (the DTO field is PR-1c's; the function already honours it). In the line's own
 *     unit; above the final quantity it is a 400.
 *  2. a line that was fully delivered (held delivered >= held qty) stays fully delivered: D' = final qty, for a raise or a cut.
 *  3. otherwise D' = min(final qty, held delivered) (A2's rule): a short line is not raised to the quantity.
 *
 * "Held delivered" is `heldDeliveredFor`: the BILLING helper's figure (`billableQtyFromBasis`), never the stored column, so
 * the column can never disagree with what the invoice bills (a legacy row-less line reads fully delivered).
 */
export interface CorrectedDeliveredHeld {
  /** The held line's delivered figure as billing reads it (`heldDeliveredFor`). */
  deliveredQty?: unknown;
  /** The held line's quantity; absent reads as "not known": rule 2 does not apply. */
  qty?: unknown;
}

export interface CorrectedDeliveredEntry {
  /** The line's FINAL stored quantity, in its own unit. */
  finalQty: number;
  /** The edit takes the line off (CANCELLED now, live before). */
  struck: boolean;
  /** The admin's explicit delivered figure (PR-1c's DTO field). */
  deliveredTo?: number | null;
}

const EPS = 0.0005;
export const DELIVERED_OVER_QTY_MESSAGE = "Delivered can't be more than the quantity.";

/** M-1 / R-222 LOW 8: what the invoice bills for the held line, the ONE figure the correction starts from. */
export function heldDeliveredFor(
  line: { id: string; qty: unknown },
  basis: DeliveredBasis,
): number {
  return billableQtyFromBasis(line, basis);
}

export function correctedDeliveredFor(
  held: CorrectedDeliveredHeld,
  entry: CorrectedDeliveredEntry,
  _floor = 0,
): number {
  if (entry.struck) return 0;
  if (entry.deliveredTo != null) {
    if (entry.deliveredTo > entry.finalQty + EPS)
      throw new BadRequestException(DELIVERED_OVER_QTY_MESSAGE);
    return Math.max(0, entry.deliveredTo);
  }
  const heldD = Number(held.deliveredQty ?? 0);
  if (held.qty != null && heldD >= Number(held.qty) - EPS) return entry.finalQty;
  return Math.min(heldD, entry.finalQty);
}
