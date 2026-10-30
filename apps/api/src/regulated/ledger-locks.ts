import { Prisma } from "@prisma/client";

/**
 * SA-839 F3: the lock step of every regulated-ledger undo (a return cancel, a credit-note void).
 *
 * House order: advisory -> Return -> Order -> Invoice -> rows (`orders/order-inline-return.ts`, SA-214).
 * A void, delete and unvoid already take Order -> Invoice first; an undo now takes the same rows, each
 * set in id order, so a concurrent void and undo of the same invoice serialise instead of each netting
 * the line without the other (B705 R15).
 *
 * SA-995: the order gets "-> RegulatedFiling (share)" appended LAST. Every ledger writer's guard
 * (`assertLedgerRowsNotLocked`) takes a FOR SHARE row lock on the covering filing rows after its other locks, and the
 * filing claim (an exclusive UPDATE of that row) is the only thing that waits on it, so neither can sit in a cycle.
 */

/** The Orders and Invoices a document's REVERSAL rows touch (read before the locks: a return's or a
 *  note's rows are written only under its own Return / CreditNote lock, so the set is stable). */
export async function ledgerDocumentTargets(
  tx: any,
  doc: { returnId: string } | { creditNoteId: string },
): Promise<{ orderIds: string[]; invoiceIds: string[] }> {
  const rows: Array<{ orderId: string | null; invoiceId: string | null }> =
    (await tx.regulatedSalesLedger.findMany({
      where: { ...doc, entryType: "REVERSAL" },
      select: { orderId: true, invoiceId: true },
    })) ?? [];
  const invoiceIds = [
    ...new Set(rows.map((r) => r.invoiceId).filter((i): i is string => !!i)),
  ].sort();
  const heads: Array<{ orderId: string | null }> =
    invoiceIds.length > 0
      ? ((await tx.invoice.findMany({
          where: { id: { in: invoiceIds } },
          select: { orderId: true },
        })) ?? [])
      : [];
  const orderIds = [
    ...new Set(
      [...rows.map((r) => r.orderId), ...heads.map((h) => h.orderId)].filter(
        (o): o is string => !!o,
      ),
    ),
  ].sort();
  return { orderIds, invoiceIds };
}

/**
 * Lock the Orders, then the Invoices, each in id order (FOR UPDATE, tenant-scoped like
 * `credit-note-locks.ts`), then bump each Invoice's row version.
 *
 * WHY THE BUMP: a void / delete runs Serializable, and its snapshot is taken at its FIRST statement
 * (tenantTransaction's `set_config`), i.e. BEFORE the Order lock it then WAITS on. If this undo holds
 * that lock and commits first, the void
 * wakes up on a snapshot that cannot see the undo's counter-entries (a lock alone raises no conflict)
 * and nets the line from stale rows (+3 left on a VOID invoice, R15 b). Updating the Invoice row (to
 * its own `updatedAt`, so the edit token is unchanged) makes the void's Invoice lock raise 40001, and
 * its `retryOnTxConflict` re-runs it on a fresh snapshot. A READ COMMITTED caller just reads the new row.
 */
export async function lockLedgerDocumentRows(
  tx: any,
  tenantId: string | null,
  sets: { orderIds: string[]; invoiceIds: string[] },
): Promise<void> {
  const orderIds = [...new Set(sets.orderIds)].sort();
  const invoiceIds = [...new Set(sets.invoiceIds)].sort();
  if (orderIds.length > 0)
    await tx.$executeRaw`SELECT id FROM "Order" WHERE id IN (${Prisma.join(orderIds)}) AND (${tenantId}::text IS NULL OR "tenantId" = ${tenantId}) ORDER BY id FOR UPDATE`;
  await lockInvoiceRowsInOrder(tx, tenantId, invoiceIds);
  await bumpInvoiceRowVersions(tx, tenantId, invoiceIds);
}

/** A new row version for each (already locked) Invoice, its values unchanged: see `lockLedgerDocumentRows`. */
export async function bumpInvoiceRowVersions(
  tx: any,
  tenantId: string | null,
  invoiceIds: string[],
): Promise<void> {
  const ids = [...new Set(invoiceIds)].sort();
  if (ids.length === 0) return;
  await tx.$executeRaw`UPDATE "Invoice" SET "updatedAt" = "updatedAt" WHERE id IN (${Prisma.join(ids)}) AND (${tenantId}::text IS NULL OR "tenantId" = ${tenantId})`;
}

/** The Invoice rows FOR UPDATE, in id order (tenant-scoped). */
export async function lockInvoiceRowsInOrder(
  tx: any,
  tenantId: string | null,
  invoiceIds: string[],
): Promise<void> {
  const ids = [...new Set(invoiceIds)].sort();
  if (ids.length === 0) return;
  await tx.$executeRaw`SELECT id FROM "Invoice" WHERE id IN (${Prisma.join(ids)}) AND (${tenantId}::text IS NULL OR "tenantId" = ${tenantId}) ORDER BY id FOR UPDATE`;
}
