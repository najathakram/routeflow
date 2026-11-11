import { invoiceLinesInOrder, loadOrderLineRanks, rankInvoiceLines } from "./invoice-line-position";

/**
 * W-1187 PR-1e (ruling (4)/(6), owner Q1 "sent invoices follow a reorder"): after the order's lines are re-slotted, every
 * live invoice of that order takes the new order IN THE SAME TRANSACTION, so the printed bill never lags the order.
 * Presentation only: no money, no revision, no email, and `position` stays out of the send fingerprint.
 *
 *  - VOID invoices are left as they were; every other status follows (draft, sent, paid ...).
 *  - A LEGACY invoice (any line without a position) is skipped: it prints A-Z for good, no backfill (owner Q2).
 *  - Lines linked to an order line take that line's new rank; a manual line or the NSF fee keeps its place after them
 *    (`rankInvoiceLines`, the same call every invoice writer uses). Only rows whose position changes are written.
 */
interface FollowDb {
  order: { findUnique: (args: any) => Promise<any> };
  invoice: { findMany: (args: any) => Promise<any[]> };
  invoiceItem: { update: (args: any) => Promise<unknown> };
}

export async function followOrderLineOrder(db: FollowDb, orderId: string): Promise<void> {
  const invoices = await db.invoice.findMany({
    where: { orderId, status: { not: "VOID" } },
    select: {
      id: true,
      items: { select: { id: true, orderItemId: true, position: true, createdAt: true } },
    },
  });
  if (invoices.length === 0) return;
  const ranks = await loadOrderLineRanks(db, orderId);
  for (const inv of invoices) {
    const items: any[] = inv.items ?? [];
    if (items.length === 0 || items.some((l) => typeof l.position !== "number")) continue;
    const shown = invoiceLinesInOrder(items);
    const next = rankInvoiceLines(shown, ranks);
    for (const [i, line] of shown.entries()) {
      if (line.position !== next[i]) {
        await db.invoiceItem.update({ where: { id: line.id }, data: { position: next[i] } });
      }
    }
  }
}
