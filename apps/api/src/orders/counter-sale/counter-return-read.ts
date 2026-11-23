import type { CounterReturnItem } from "@routeflow/types";
import type { ReceiptPaymentInput, ReceiptReturnData } from "../../documents/receipt-model";
import type { PrismaService } from "../../prisma/prisma.service";
import { lineOfItem } from "../../returns/return-line-items";
import { DEAD_RETURN_STATUSES } from "../../returns/return-statuses";
import type { OrderLineForPieces } from "../../returns/returns-pieces.util";
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

/**
 * SA-1211 A1.1 (VF-6): the items a counter sale's returns took back, from the STORED return lines (name, quantity, reason code;
 * served as given, never re-derived), for the receipt's "returned items" list. The returns are the ones `readReturnData` named
 * (the order's own and the carried ones), each read once; none live, or no lines found: undefined (never an empty list), so a
 * plain sale gains no query and an older reader sees no field.
 */
export async function readReturnItems(
  tenantId: string,
  db: ReturnType<PrismaService["forTenant"]>,
  returns: ReadonlyArray<{ id?: string; status?: string | null }>,
): Promise<CounterReturnItem[] | undefined> {
  const ids = [
    ...new Set(
      returns
        .filter((r) => !(DEAD_RETURN_STATUSES as readonly string[]).includes(r.status ?? ""))
        .flatMap((r) => (r.id ? [r.id] : [])),
    ),
  ];
  if (ids.length === 0) return undefined;
  const rows: Array<{
    qty: unknown;
    reason: string | null;
    sourceOrderItemId: string | null;
    product: { name: string } | null;
    return: { kind: "INLINE" | "STANDARD" } | null;
  }> = await db.returnItem.findMany({
    where: { tenantId, returnId: { in: ids } },
    select: {
      qty: true,
      reason: true,
      sourceOrderItemId: true,
      product: { select: { name: true } },
      return: { select: { kind: true } },
    },
    orderBy: { id: "asc" },
  });
  if (rows.length === 0) return undefined;
  // SA-1231: each item names the sold line it came off; ONE batched read of those lines (a snapshot, never the live product)
  const lineIds = [
    ...new Set(rows.flatMap((r) => (r.sourceOrderItemId ? [r.sourceOrderItemId] : []))),
  ];
  const lineItems: OrderLineForPieces[] = lineIds.length
    ? await db.orderItem.findMany({
        where: { tenantId, id: { in: lineIds } },
        select: {
          id: true,
          productId: true,
          qty: true,
          unitLabel: true,
          unitsPerBox: true,
          boxes: true,
          pieces: true,
        },
      })
    : [];
  return rows.map((r) => ({
    name: r.product?.name ?? "Item",
    qty: Number(r.qty),
    reason: r.reason?.trim() ? r.reason : null,
    ...(r.return ? { kind: r.return.kind } : {}),
    line: lineOfItem(r, { lineItems }),
  }));
}
