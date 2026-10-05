import { ConflictException } from "@nestjs/common";
import { FulfillPath, OrderStatus, type Order } from "@prisma/client";
import { API_ERROR_CODES } from "../common/api-error-codes";
import type { PrismaService } from "../prisma/prisma.service";

/**
 * `OrdersService.changeStatus`'s status write, lifted out of the method (size-ratchet slice for B1095;
 * the data builder is verbatim). Pure: no DB, no `this`.
 */
export function buildStatusUpdateData(
  order: Pick<Order, "deliveredAt" | "orderDate" | "fulfillPath" | "shippedAt" | "notes">,
  status: OrderStatus,
  opts: { isDeliveredDemotion: boolean; noteAppend?: string },
) {
  return {
    status,
    // A backdated order was delivered on its business date, not on the day
    // staff got around to marking it.
    ...(status === OrderStatus.DELIVERED
      ? { deliveredAt: order.deliveredAt ?? order.orderDate ?? new Date() }
      : {}),
    // A reopened order is no longer delivered — a stale deliveredAt would
    // keep it in delivered-on-date reports and reconcile passes.
    ...(opts.isDeliveredDemotion ? { deliveredAt: null } : {}),
    // E-b: shippedAt is stamped ONLY by the ship transition (never by saving tracking) and survives an unmark.
    ...(status === OrderStatus.OUT_FOR_DELIVERY && order.fulfillPath === FulfillPath.SHIP
      ? { shippedAt: order.shippedAt ?? new Date() }
      : {}),
    ...(opts.noteAppend ? { notes: (order.notes ?? "") + opts.noteAppend } : {}),
  };
}

/**
 * B1095: the generic status write as a compare-and-set on `from`, the status the transition was
 * validated against. A cancel (or any other status change) that committed between the unlocked pre-read
 * and this write leaves no row matching, Prisma raises P2025, and it becomes the same 409 the cancel's
 * own claim answers with — never an overwrite of the newer status (a cancelled order resurrected with
 * its invoices voided and its stock already credited back). Any other error passes through untouched.
 */
export async function writeStatusIfUnchanged(
  db: ReturnType<PrismaService["forTenant"]>,
  id: string,
  from: OrderStatus,
  data: ReturnType<typeof buildStatusUpdateData>,
) {
  try {
    return await db.order.update({ where: { id, status: from }, data });
  } catch (e) {
    if ((e as { code?: string } | null)?.code !== "P2025") throw e;
    throw new ConflictException({
      code: API_ERROR_CODES.ORDER_CHANGED_DURING_EDIT,
      message:
        "The order's status changed while this change was being made — review it and try again.",
    });
  }
}
