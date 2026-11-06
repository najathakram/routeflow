import type { ReceiptPaymentInput, ReceiptReturnData } from "../../documents/receipt-model";
import type { PrismaService } from "../../prisma/prisma.service";
import {
  carriedReturnSelect,
  carriedReturnWhere,
  creditNoteFacts,
  creditNoteIdsToRead,
  creditNoteReadSelect,
  creditNoteReadWhere,
  orderReturnSelect,
  pageCreditNoteIds,
  type ReturnProvenance,
  type TodayOrderRecord,
} from "./counter-sale-today";

/**
 * The reads a COUNTER sale's return split needs, by the Today's-sales read shapes; none for any other order. The order's own
 * returns (`orderReturnSelect`, by `orderId`), ONE batched read of the returns carried elsewhere (`carriedReturnWhere`, the
 * Today page's own where: behind a payment's credit note, or with an item sold on this order), and ONE read of every credit note
 * the payments and those returns name (status, the invoice it was issued against, and the PAID amount applied anywhere).
 * Tenant-scoped, one id list each, never per payment. The notes' invoice links also complete the payments (link 2 of the
 * provenance: a payment is the sale's own return credit only when its note was issued against one of this order's invoices).
 *
 * SA-1077 / W-1090: the ONE copy. The emailed receipt and the till's counter-sale response both read through it.
 */
export async function readReturnData(
  tenantId: string,
  db: ReturnType<PrismaService["forTenant"]>,
  orderId: string,
  payments: ReceiptPaymentInput[],
): Promise<{ returnData: ReceiptReturnData; payments: ReceiptPaymentInput[] }> {
  const returns: TodayOrderRecord["returns"] = await db.return.findMany({
    where: { tenantId, orderId },
    select: orderReturnSelect,
  });
  const paymentNoteIds = pageCreditNoteIds([{ invoices: [{ payments }] }]);
  const carriedReturns: ReturnProvenance[] = await db.return.findMany({
    where: carriedReturnWhere(tenantId, paymentNoteIds, [orderId]),
    select: carriedReturnSelect,
  });
  const noteIds = creditNoteIdsToRead([{ invoices: [{ payments }], returns }], carriedReturns);
  const noteRows =
    noteIds.length === 0
      ? []
      : await db.creditNote.findMany({
          where: creditNoteReadWhere(tenantId, noteIds),
          select: creditNoteReadSelect,
        });
  const invoiceOfNote = new Map(
    noteRows.map((n: { id: string; invoiceId: string | null }) => [n.id, n.invoiceId]),
  );
  return {
    returnData: { returns, carriedReturns, creditNotes: creditNoteFacts(noteRows) },
    // a payment whose note the read did not return has no invoice link: it stays a tender
    payments: payments.map((p) => ({
      ...p,
      creditNote: p.creditNoteId ? { invoiceId: invoiceOfNote.get(p.creditNoteId) ?? null } : null,
    })),
  };
}
