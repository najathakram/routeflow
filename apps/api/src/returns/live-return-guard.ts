/**
 * SA-1101 A-3 (N1) / A-4: the one rule "an order with a live return does not move" — a live return is any that is
 * not REJECTED / CANCELLED, on the order by either link (`liveReturnWhere`, A-6). Order stock books once and a return books its own credit, so a REFUSED order that is
 * delivered again (or whose refusing stop is undone) while a return stands would leave stock too high, and a pending
 * return received afterwards would restock goods that went out again. The way back is the return's own cancel.
 *
 * Exactly three callers, pinned by live-return-guard.structure.spec.ts: `deliverAgainInTx` (orders/deliver-again.ts),
 * `RoutesService.reopenStop` and `guardDeliveredDemotion` (orders/order-ship-state.ts, SA-1101 A-5). The caller holds the Order row lock(s) first, so a return create (which takes the
 * same lock before it re-reads the status) cannot slip in between this count and the write that follows it.
 */
import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { lockOrderRows } from "../credit-notes/credit-note-locks";
import { DEAD_RETURN_STATUSES } from "./return-statuses";

export const UNDO_STOP_RETURN_MESSAGE =
  "An order on this stop has a return. To undo the stop, cancel the return first.";

/** SA-1101 A-5 (B1272): the office demotion out of DELIVERED (-> CONFIRMED, -> PARTIALLY_DELIVERED). */
export const DEMOTE_RETURN_MESSAGE =
  "This order has a return. To change its delivery status, cancel the return first.";

type CountTx = { return: { count: (args: any) => Promise<number> } };
type LockTx = CountTx & Parameters<typeof lockOrderRows>[0];

/**
 * SA-1101 A-6: the ONE predicate for "a live return stands on these orders". A return is on an order by either link:
 * the CARRYING order (`Return.orderId`, where an INLINE return's credit lands) or the order the goods were SOLD on
 * (`ReturnItem.sourceOrderId`). An inline return restocks at capture unless held, so counting only the carrying link
 * let an order sold-from pass the guard while its goods were already back on the shelf. The carrying link still counts
 * (its credit sits on that order's invoice); the `some` rides the `[sourceOrderId, productId]` index.
 */
export function liveReturnWhere(orderIds: readonly string[]) {
  const ids = [...orderIds];
  return {
    status: { notIn: DEAD_RETURN_STATUSES },
    OR: [{ orderId: { in: ids } }, { items: { some: { sourceOrderId: { in: ids } } } }],
  };
}

export async function assertNoLiveReturn(
  tx: CountTx,
  orderIds: readonly string[],
  message: string,
): Promise<void> {
  if (orderIds.length === 0) return;
  const live = await tx.return.count({ where: liveReturnWhere(orderIds) });
  if (live > 0) throw new ConflictException({ code: API_ERROR_CODES.ORDER_HAS_RETURN, message });
}

/**
 * For a caller that does not hold the Order rows yet: lock them (FOR UPDATE, id order, the lock a return create takes),
 * then run the check. The lock comes first by construction, so a return created in between cannot slip past the count.
 */
export async function lockThenAssertNoLiveReturn(
  tx: LockTx,
  orderIds: readonly string[],
  message: string,
): Promise<void> {
  await lockOrderRows(tx, null, orderIds);
  await assertNoLiveReturn(tx, orderIds, message);
}
