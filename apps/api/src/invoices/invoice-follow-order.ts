import { invoiceLinesInOrder, loadOrderLineRanks, rankInvoiceLines } from "./invoice-line-position";

/**
 * W-1187 PR-1e (ruling (4)/(6), owner Q1 "sent invoices follow a reorder"): after the order's lines are re-slotted, every
 * live invoice of that order takes the new order IN THE SAME TRANSACTION, so the printed bill never lags the order.
 * Presentation only: no money, no revision, no email, and `position` stays out of the send fingerprint.
 *
 *  - VOID and WRITTEN_OFF invoices are closed documents and are left as they were; every other status follows.
 *  - A LEGACY invoice (a line without a position) of THIS order is stamped by this write: its current shown order is the
 *    A-Z fallback, which `rankInvoiceLines` then re-ranks by the order. Owner Q2 forbids a mass backfill, not a user's
 *    explicit reorder ("a legacy invoice leaves the fallback when a reorder of its order re-ranks it", ruling Q2 + D2).
 *    An invoice of any other order is never read, so it stays NULL and A-Z.
 *  - Invoices' updatedAt is not bumped (ruling (4), last bullet).
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
    where: { orderId, status: { notIn: ["VOID", "WRITTEN_OFF"] } },
    select: {
      id: true,
      items: { select: { id: true, orderItemId: true, position: true, createdAt: true } },
    },
  });
  if (invoices.length === 0) return;
  const ranks = await loadOrderLineRanks(db, orderId);
  for (const inv of invoices) {
    const items: any[] = inv.items ?? [];
    if (items.length === 0) continue;
    const shown = invoiceLinesInOrder(items);
    const next = rankInvoiceLines(shown, ranks);
    for (const [i, line] of shown.entries()) {
      if (line.position !== next[i]) {
        await db.invoiceItem.update({ where: { id: line.id }, data: { position: next[i] } });
      }
    }
  }
}
