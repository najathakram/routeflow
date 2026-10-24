import { InvoiceStatus } from "@prisma/client";
import { aggregateInvoiceLines } from "./order-backsync-aggregate";

/**
 * SA-816: `recomputeOrderFromInvoices` runs AFTER an invoice edit commits, and its aggregation
 * (`aggregateInvoiceLines`) refuses a stored non-finite amount on ANY non-void invoice of the order. Without a
 * look-ahead an edit of invoice A whose SIBLING B carries a NaN would commit A and then answer 400: the save
 * looks failed while A is saved and the order is out of step.
 *
 * This runs the SAME guarded aggregation over the order's non-void invoices BEFORE the first write of the edit,
 * so the refusal (400 MONEY_INVARIANT) leaves nothing written (SA rule: no invoice write commits before the
 * refusal). Pass `exceptInvoiceId` only when EVERY stored column of the edited invoice that survives the edit
 * and feeds the back-sync (unit price, qty, subtotal, levy) is guarded when the edit's lines are built: that is
 * the DRAFT items update (invoice-edit-plan.ts buildEditedLines). The header discount/shipping path and the
 * SINGLE price adjustment keep the edited invoice's stored rows (an un-repriced line keeps its stored unit
 * price and qty), so they pass null and the invoice is judged as currently stored. No-op for an invoice with no
 * order.
 *
 * `db` is the client the edit runs on (the transaction after its locks, or the tenant client before a
 * transaction that is not shared with a bulk loop).
 */
export async function preflightOrderSiblings(
  db: any,
  orderId: string | null | undefined,
  exceptInvoiceId: string | null,
): Promise<void> {
  if (!orderId) return;
  const order = await db.order.findUnique({ where: { id: orderId }, include: { lineItems: true } });
  if (!order) return;
  const siblings = await db.invoice.findMany({
    where: {
      orderId,
      status: { not: InvoiceStatus.VOID },
      ...(exceptInvoiceId ? { id: { not: exceptInvoiceId } } : {}),
    },
    include: { items: true },
  });
  if (!siblings?.length) return;
  aggregateInvoiceLines(
    order.lineItems ?? [],
    siblings.map((s: any) => ({ ...s, items: s.items ?? [] })),
  );
}
