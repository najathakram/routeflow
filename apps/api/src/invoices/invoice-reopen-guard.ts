import { BadRequestException, NotFoundException } from "@nestjs/common";
import { InvoiceStatus } from "@prisma/client";
import { assertWalkInSaleEditable } from "../orders/counter-sale/walk-in-sale-lock";

/**
 * `reopenInvoice`'s read and refusals, before any write: the invoice exists and is PAID; and (W-861 sibling sweep,
 * SA-944 §3 MUST 4) it is not a paid walk-in sale's invoice. Reopening keeps the payments and makes the invoice an
 * editable DRAFT whose total can rise, which would leave the shared Walk-in customer owing. Same predicate as the
 * order edit (`walkInSaleLocked`), same 409 WALK_IN_SALE_PAID. Kept out of invoices.service.ts (size ratchet).
 */
export async function loadReopenableInvoice(db: any, id: string) {
  const inv = await db.invoice.findUnique({ where: { id } });
  if (!inv) throw new NotFoundException("Invoice not found");
  if (inv.status !== InvoiceStatus.PAID)
    throw new BadRequestException("Only PAID invoices can be reopened");
  if (inv.orderId) {
    const customer = await db.customer.findUnique({
      where: { id: inv.customerId },
      select: { isWalkIn: true },
    });
    await assertWalkInSaleEditable(db, { id: inv.orderId, customer });
  }
  return inv;
}
