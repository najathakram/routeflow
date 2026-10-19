import { InvoiceStatus } from "@prisma/client";
import { aggregateInvoiceLines } from "./order-backsync-aggregate";

/**
 * SA-816: `recomputeOrderFromInvoices` runs AFTER an invoice edit commits, and its aggregation
 * (`aggregateInvoiceLines`) refuses a stored non-finite amount on ANY non-void invoice of the order. Without a
 * look-ahead an edit of invoice A whose SIBLING B carries a NaN would commit A and then answer 400: the save
 * looks failed while A is saved and the order is out of step.
 *
 * This runs the SAME guarded aggregation over the order's other non-void invoices BEFORE the first write of the
 * edit, so the refusal (400 MONEY_INVARIANT) leaves nothing written. The edited invoice itself is left out: its
 * own rows are replaced or re-priced by the edit, and its own stored values are judged by that edit's plan and
 * strict totals. No-op for an invoice with no order or an order with no other invoice.
 *
 * `db` is the client the edit runs on (the transaction after its locks, or the tenant client before a
 * transaction that is not shared with a bulk loop).
 */
export async function preflightOrderSiblings(
  db: any,
  orderId: string | null | undefined,
  editedInvoiceId: string,
): Promise<void> {
  if (!orderId) return;
  const order = await db.order.findUnique({ where: { id: orderId }, include: { lineItems: true } });
  if (!order) return;
  const siblings = await db.invoice.findMany({
    where: { orderId, status: { not: InvoiceStatus.VOID }, id: { not: editedInvoiceId } },
    include: { items: true },
  });
  if (!siblings?.length) return;
  aggregateInvoiceLines(
    order.lineItems ?? [],
    siblings.map((s: any) => ({ ...s, items: s.items ?? [] })),
  );
}
