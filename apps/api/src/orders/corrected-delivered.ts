/**
 * SA-1514 (Amendment 3) R1: the ONE corrected delivered figure, D', of a CORRECT line. Every basis (NONE, OFFICE and, in
 * PR-1c, ROUTE) reads this function, so the column, the evidence rows and the stock settle never disagree.
 *
 * First match wins. PR-1a carries only case 3 (Amendment 2's rule); PR-1c adds case 1 (the entry's `deliveredTo`) and case 2
 * (a fully delivered line stays fully delivered) and the return floor (`floor`, a 409 below it) in this same function.
 *
 *  3. D' = min(final qty, held delivered); a take-off (the line struck) delivers 0.
 *
 * A correction only ever lowers delivered here: a raise leaves delivered where it was (the line is short again and the
 * office marks it delivered).
 */
export interface CorrectedDeliveredHeld {
  deliveredQty?: unknown;
}

export interface CorrectedDeliveredEntry {
  /** The line's FINAL stored quantity, in its own unit. */
  finalQty: number;
  /** The edit takes the line off (CANCELLED now, live before). */
  struck: boolean;
}

export function correctedDeliveredFor(
  held: CorrectedDeliveredHeld,
  entry: CorrectedDeliveredEntry,
  _floor = 0,
): number {
  if (entry.struck) return 0;
  return Math.min(Number(held.deliveredQty ?? 0), entry.finalQty);
}
