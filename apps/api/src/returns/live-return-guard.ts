/**
 * SA-1101 A-3 (N1) / A-4: the one rule "an order with a live return does not move" — a live return is any that is
 * not REJECTED / CANCELLED. Order stock books once and a return books its own credit, so a REFUSED order that is
 * delivered again (or whose refusing stop is undone) while a return stands would leave stock too high, and a pending
 * return received afterwards would restock goods that went out again. The way back is the return's own cancel.
 *
 * Exactly two callers, pinned by live-return-guard.structure.spec.ts: `deliverAgainInTx` (orders/deliver-again.ts)
 * and `RoutesService.reopenStop`. The caller holds the Order row lock(s) first, so a return create (which takes the
 * same lock before it re-reads the status) cannot slip in between this count and the write that follows it.
 */
import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { DEAD_RETURN_STATUSES } from "./return-statuses";

export const UNDO_STOP_RETURN_MESSAGE =
  "An order on this stop has a return. To undo the stop, cancel the return first.";

type CountTx = { return: { count: (args: any) => Promise<number> } };

export async function assertNoLiveReturn(
  tx: CountTx,
  orderIds: readonly string[],
  message: string,
): Promise<void> {
  if (orderIds.length === 0) return;
  const live = await tx.return.count({
    where: { orderId: { in: [...orderIds] }, status: { notIn: DEAD_RETURN_STATUSES } },
  });
  if (live > 0) throw new ConflictException({ code: API_ERROR_CODES.ORDER_HAS_RETURN, message });
}
