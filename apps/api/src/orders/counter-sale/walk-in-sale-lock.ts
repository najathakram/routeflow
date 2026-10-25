import { ConflictException } from "@nestjs/common";
import { InvoiceStatus } from "@prisma/client";
import { BLOCKING_PAYMENT } from "@routeflow/pricing";
import type { OrderEditItemsLockField } from "@routeflow/types";
import { API_ERROR_CODES } from "../../common/api-error-codes";

/**
 * W-861 (SA-944 §3): a walk-in pays in full at the till and holds no receivable and no credit (SA-932). An edit that
 * changes a PAID walk-in sale would leave a balance (or an overpayment) on the shared Walk-in customer, who cannot
 * be collected from. ONE predicate: the order's customer is the walk-in AND a live (not VOID) payment sits on one of
 * its live invoices. `updateOrderItems` refuses on it before any write; the order read sends it as
 * `editItemsLocked`, so the web hides Edit items and never re-derives it. An unpaid walk-in pickup stays editable;
 * a named customer's paid counter sale keeps R1 (a balance on a real account can be collected).
 */
export const WALK_IN_SALE_PAID_MESSAGE =
  "This sale is paid. Ring up added items as a new sale, or use Return to take items back.";

type PaymentReader = {
  invoicePayment: { findFirst(args: unknown): Promise<{ id: string } | null> };
};

export async function walkInSaleLocked(
  db: PaymentReader,
  order: { id: string; customer?: { isWalkIn?: boolean | null } | null },
): Promise<OrderEditItemsLockField["editItemsLocked"]> {
  if (order.customer?.isWalkIn !== true) return false; // a named customer: no read
  const live = await db.invoicePayment.findFirst({
    where: {
      ...BLOCKING_PAYMENT,
      invoice: { orderId: order.id, status: { not: InvoiceStatus.VOID } },
    },
    select: { id: true },
  });
  return live != null;
}

export async function assertWalkInSaleEditable(
  db: PaymentReader,
  order: { id: string; customer?: { isWalkIn?: boolean | null } | null },
): Promise<void> {
  if (await walkInSaleLocked(db, order))
    throw new ConflictException({
      code: API_ERROR_CODES.WALK_IN_SALE_PAID,
      message: WALK_IN_SALE_PAID_MESSAGE,
    });
}
