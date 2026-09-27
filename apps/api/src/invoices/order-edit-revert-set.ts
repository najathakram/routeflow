import { InvoiceStatus } from "@prisma/client";

/**
 * #2178 — the ONE selection of the invoices an UNDELIVERED order edit reverts to DRAFT
 * (`InvoicesService.revertLinkedInvoicesForOrderEdit`), lifted out of that method so the inline-return
 * preflight can price against the matching set as it will be AFTER the revert: the revert turns these
 * into DRAFTs of an undelivered order, which the matching set (§3.1) does not include. One predicate,
 * never a second copy.
 *
 * The order's own non-batch SENT/VIEWED/OVERDUE invoices, minus the exempt deposit mirror: a
 * deposit-carrying invoice that is the order's SOLE non-void invoice, on an order not yet
 * DELIVERED/CANCELLED, stays SENT (the widened reconcile re-syncs it, and its payments stay attached
 * to a still-issued document). The fence reads run only when a deposit invoice is in play, so an order
 * with no deposit mirror issues exactly the one query it always did.
 */
export interface EditRevertCandidate {
  id: string;
  invoiceNumber: string;
  internalNotes: string | null;
  depositPercent: unknown;
}

interface RevertSetDb {
  invoice: {
    findMany(args: unknown): Promise<any[]>;
    count(args: unknown): Promise<number>;
  };
  order: { findFirst(args: unknown): Promise<{ status: string } | null> };
}

export async function selectEditRevertedInvoices(
  db: RevertSetDb,
  orderId: string,
): Promise<EditRevertCandidate[]> {
  const linked: EditRevertCandidate[] = await db.invoice.findMany({
    where: {
      orderId,
      deliveryBatchId: null,
      status: { in: [InvoiceStatus.SENT, InvoiceStatus.VIEWED, InvoiceStatus.OVERDUE] },
    },
    select: { id: true, invoiceNumber: true, internalNotes: true, depositPercent: true },
  });
  if (!linked.some((inv) => inv.depositPercent != null)) return linked;
  const order = await db.order.findFirst({ where: { id: orderId }, select: { status: true } });
  const nonVoidCount = await db.invoice.count({
    where: { orderId, status: { not: InvoiceStatus.VOID } },
  });
  const depositMirrorExempt =
    !!order && order.status !== "DELIVERED" && order.status !== "CANCELLED" && nonVoidCount === 1;
  return depositMirrorExempt ? linked.filter((inv) => inv.depositPercent == null) : linked;
}
