/**
 * SA-1026 Part A: the staff order detail's `toCollect` ("a check not received yet"). Rolled up from the order's invoices
 * through the one rule in invoices/to-collect.ts, so the order, its invoices and the Today's sales row never disagree.
 * Kept out of orders.service.ts (size ratchet), and out of ORDER_INVOICES_SELECT so a buyer's read of the same
 * `findOne` can never carry the intent.
 *
 * STAFF ONLY, failing closed (same office roles as the invoices-need-review signal): a buyer, customer, driver or buyer
 * pseudo-user gets NO field and NO query. Advisory: a failing read leaves the field out, it never fails the order read.
 * Cost (staff read only): one indexed read of the order's invoices that carry an intent (none for most orders).
 */
import { Logger } from "@nestjs/common";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { rollupToCollect, toCollectState, type ToCollectState } from "../invoices/to-collect";
import { seesInvoicesNeedReview as seesToCollect } from "./order-invoices-review";

const logger = new Logger("OrderToCollect");

/** `db` is the tenant-scoped client (`prisma.forTenant()`). */
export async function attachOrderToCollect(
  db: {
    invoice: {
      findMany(args: {
        where: { orderId: string; expectedPaymentMethod: { not: null } };
        select: { status: true; expectedPaymentMethod: true };
      }): Promise<{ status: string; expectedPaymentMethod: string | null }[]>;
    };
  },
  order: { id: string },
  user: Pick<JwtPayload, "role" | "type">,
): Promise<void> {
  if (!seesToCollect(user)) return;
  try {
    const rows = await db.invoice.findMany({
      where: { orderId: order.id, expectedPaymentMethod: { not: null } },
      select: { status: true, expectedPaymentMethod: true },
    });
    (order as { toCollect?: ToCollectState }).toCollect = rollupToCollect(rows.map(toCollectState));
  } catch (err) {
    logger.warn(`toCollect for order ${order.id} skipped: ${(err as Error)?.message ?? err}`);
  }
}
