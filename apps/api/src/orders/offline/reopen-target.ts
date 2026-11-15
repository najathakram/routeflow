import { ConflictException, Logger } from "@nestjs/common";
import { OrderStatus } from "@prisma/client";
import { AUDIT_ACTIONS } from "../../audit/audit-actions.constant";
import { API_ERROR_CODES } from "../../common/api-error-codes";
import { GATE_FLAG_KINDS } from "./review-flags";

const log = new Logger("reopenTarget");

/** What the order's newest cancelled-or-reopened audit row says it was cancelled from (SA-1136 R-3). */
export type CancelledFrom = "draft" | "live" | "unknown";

/**
 * SA-1136 R-3: classify the order's newest `order.cancelled` / `order.reopened` row.
 * - "draft": the newest row is `order.cancelled` with `meta.fromStatus === "DRAFT"`.
 * - "live": the newest row is `order.cancelled` with any other `OrderStatus` value.
 * - "unknown": no row (cancelled before the row existed), a newer `order.reopened` (an unrecorded cancel since), or a
 *   `meta` that cannot be read (logged at warn with the order id).
 */
export function cancelledFrom(
  newest: { action: string; meta: unknown } | null,
  orderId: string,
): CancelledFrom {
  if (!newest || newest.action !== AUDIT_ACTIONS.ORDER_CANCELLED) return "unknown";
  const from = (newest.meta as { fromStatus?: unknown } | null)?.fromStatus;
  if (from === OrderStatus.DRAFT) return "draft";
  if (typeof from === "string" && (Object.values(OrderStatus) as string[]).includes(from))
    return "live";
  log.warn(
    `order ${orderId}: the order.cancelled row has no readable fromStatus; treated as unknown`,
  );
  return "unknown";
}

/**
 * The status a cancelled order reopens to. The first row that matches wins (SA-1136 table):
 *  1. cancelled from DRAFT                          -> DRAFT (the line flip, stock re-take and restriction check are skipped)
 *  2. cancelled from a live status + open gate flag -> refused: an invariant breach (a gate flag lives only on a DRAFT)
 *  3. cancelled from a live status                  -> PENDING
 *  4. no usable record + open gate flag             -> DRAFT (SA-1134 R-1: gate flags clear only through promotion)
 *  5. no usable record                              -> PENDING (an order cancelled before the record existed; as always)
 * An order with only MANUAL flags (a price drift) has no open gate flag and reopens as rows 3 and 5 say.
 *
 * Read twice by `reopenOrder`: before its restriction check (a DRAFT target skips it: promotion judges the draft later),
 * and again under the Order row lock by `claimReopenInTx`, which refuses to claim when the two reads disagree.
 */
export async function reopenTarget(
  db: {
    orderReviewFlag: { count(args: any): Promise<number> };
    auditLog: { findFirst(args: any): Promise<{ action: string; meta: unknown } | null> };
  },
  orderId: string,
): Promise<OrderStatus> {
  const newest = await db.auditLog.findFirst({
    where: {
      entityType: "Order",
      entityId: orderId,
      action: { in: [AUDIT_ACTIONS.ORDER_CANCELLED, AUDIT_ACTIONS.ORDER_REOPENED] },
    },
    orderBy: { createdAt: "desc" },
    select: { action: true, meta: true },
  });
  const from = cancelledFrom(newest, orderId);
  if (from === "draft") return OrderStatus.DRAFT;
  const openGate =
    (await db.orderReviewFlag.count({
      where: { orderId, kind: { in: [...GATE_FLAG_KINDS] }, resolvedAt: null },
    })) > 0;
  if (from === "live" && openGate) {
    log.error(
      `order ${orderId}: cancelled from a live status but holds an open gate flag; reopen refused`,
    );
    throw new ConflictException({
      code: API_ERROR_CODES.ORDER_CHANGED_DURING_EDIT,
      message: "The order changed while it was being reopened — review it and try again.",
    });
  }
  return openGate ? OrderStatus.DRAFT : OrderStatus.PENDING;
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
