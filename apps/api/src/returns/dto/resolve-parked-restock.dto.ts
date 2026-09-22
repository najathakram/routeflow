import { IsInt, Max, Min } from "class-validator";

/**
 * The operator's answer for a parked restock: the PACK only (units per box of the sold line). The quantity is
 * never retyped: it is the row's stored `returnedQty`. Under the global whitelist pipe any other field is
 * rejected.
 *
 * The minimum is 1, not 2 (owner ruling 2026-09-22). A pack of 1 is a legitimate answer, not a sentinel: a
 * line can park with a true factor of 1 — a box-unaware line carrying a pack snapshot but no split, on an
 * UNINVOICED order, has no InvoiceItem source, so the classifier returns `unknown` even though its `qty` is
 * already a piece count. Rejecting 1 would strand those rows in the queue with no exit, and an unresolvable
 * park is a 100% undercount, worse than the 12x it guards against. `@Min(2)` would also repeat B664's
 * mistake of treating a pack of 1 as "no packaging".
 */
export class ResolveParkedRestockDto {
  @IsInt()
  @Min(1)
  @Max(10000)
  unitsPerBoxSupplied!: number;
}
