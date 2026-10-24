import { ConflictException, Logger } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";

/**
 * W-762 / SA-918 §2: no customer-level merge while ANY participant — the winner included — carries an order discount.
 * The merge re-total cannot carry it yet: summing the discounts onto the winner is SA-780's allocation question (its
 * "merge winner vs CHECK"), parked. Until it is decided an EXPLICIT merge (force-consolidate) refuses with 409
 * ORDER_MERGE_DISCOUNTED, and an AUTOMATIC one (create's post-commit fold, the buyer cart fold, the template cron, the
 * hourly sweep) skips with the reason DISCOUNTED: the orders stay separate, nothing fails.
 * Judged under the customer's merge lock on the rows the merge reads (readMergeGroup, also re-run inside the merge's tx
 * on the locked rows), before any write.
 */
export const DISCOUNTED_SKIP_REASON = "DISCOUNTED";

const logger = new Logger("OrderMerge");

export function mergeBlockedByDiscount(
  participants: ReadonlyArray<{ discountAmount?: unknown } | null | undefined>,
): boolean {
  return participants.some((o) => Number(o?.discountAmount ?? 0) > 0);
}

export function orderMergeDiscounted(): ConflictException {
  return new ConflictException({
    code: API_ERROR_CODES.ORDER_MERGE_DISCOUNTED,
    message:
      "An order in this merge has an order discount. Merge them after removing it, or keep them separate.",
  });
}

/** One log line naming the skip and its reason (the sweep's per-customer line; never an error). */
export function logDiscountedSkip(where: string, customerId: string): void {
  logger.log(`${where}: merge skipped for customer ${customerId} (${DISCOUNTED_SKIP_REASON})`);
}
