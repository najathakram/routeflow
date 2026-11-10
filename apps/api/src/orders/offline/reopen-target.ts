import { OrderStatus } from "@prisma/client";
import { GATE_FLAG_KINDS } from "./review-flags";

/**
 * SA-1134 R-1: an order holding an open GATE flag (RESTRICTED, LICENSE_REQUIRED, CREDIT_BLOCKED) lives only on a DRAFT:
 * those flags clear only by passing the draft's promotion (`resolveGateFlagsAtPromotion`). So a cancelled one reopens to
 * DRAFT, never to PENDING (a live order that skipped the credit gate, the license guard and the restriction check), with
 * every flag left open. An order with no open gate flag (none at all, only manual kinds such as a price drift, or gate
 * flags a promotion already resolved) reopens to PENDING, as always.
 *
 * Read twice by `reopenOrder`: before its restriction check (a DRAFT target skips it: promotion judges the draft later),
 * and again under the Order row lock by `claimReopenInTx`, which refuses to claim when the two reads disagree.
 */
export async function reopenTarget(
  db: { orderReviewFlag: { count(args: any): Promise<number> } },
  orderId: string,
): Promise<OrderStatus> {
  const open = await db.orderReviewFlag.count({
    where: { orderId, kind: { in: [...GATE_FLAG_KINDS] }, resolvedAt: null },
  });
  return open > 0 ? OrderStatus.DRAFT : OrderStatus.PENDING;
}

/**
 * The reopen's restriction check, skipped for a DRAFT target: a DRAFT is judged at its promotion (which re-runs the
 * restriction check, the license guard and the credit gate), and judging it here would refuse to reopen a
 * RESTRICTED-flagged draft at all. `judge` is only called for a PENDING target.
 */
export async function judgeUnlessDraft<T>(
  target: OrderStatus,
  judge: () => Promise<T>,
): Promise<T | undefined> {
  return target === OrderStatus.DRAFT ? undefined : judge();
}
