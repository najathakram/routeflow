import { Prisma } from "@prisma/client";

/**
 * B1052: row locks for every writer of `CreditNote.amountUsed`, taken BEFORE the caller reads a
 * note's balance, in the SA-214 global order (Order → Invoice → CreditNote, each set in id order —
 * the same order `voidWithReversalInTx` and `lockInvoicesForPayment` take). Without them two
 * transactions both read the same `amountUsed`, both spend the same dollars and the last write
 * wins: a $100 note paid $200 of invoices (two office settles), or a restore racing an apply lost
 * one of its writes.
 *
 * Plain row locks inside the caller's transaction (no new in-process lock); in a Serializable
 * caller they turn a late 40001 retry into an early wait. Raw statements only, so every helper
 * locks without reading a model row of its own. Re-locking a row the caller already holds is a
 * no-op.
 */

/** The given notes, in id order. */
export async function lockCreditNotes(
  tx: any,
  ids: Array<string | null | undefined>,
): Promise<void> {
  const sorted = [...new Set(ids.filter((id): id is string => !!id))].sort();
  if (sorted.length === 0) return;
  await tx.$executeRaw`SELECT id FROM "CreditNote" WHERE id IN (${Prisma.join(sorted)}) ORDER BY id FOR UPDATE`;
}

/** An invoice's Order (when it has one), then the invoice: the SA-214 prefix of a credit write. */
export async function lockInvoiceForCredit(tx: any, invoiceId: string): Promise<void> {
  await tx.$executeRaw`SELECT id FROM "Order" WHERE id = (SELECT "orderId" FROM "Invoice" WHERE id = ${invoiceId}) FOR UPDATE`;
  await tx.$executeRaw`SELECT id FROM "Invoice" WHERE id = ${invoiceId} FOR UPDATE`;
}

/**
 * `settleOrderCreditsInTx`'s FIRST statements: this Order, every invoice of the order, then every
 * note the settle can touch — the notes its intents name and the notes already paying its invoices
 * (the shrink pass restores those).
 */
export async function lockOrderCreditSettle(tx: any, orderId: string): Promise<void> {
  await tx.$executeRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
  await tx.$executeRaw`SELECT id FROM "Invoice" WHERE "orderId" = ${orderId} ORDER BY id FOR UPDATE`;
  await tx.$executeRaw`SELECT id FROM "CreditNote" WHERE id IN (
      SELECT "creditNoteId" FROM "OrderCreditNote" WHERE "orderId" = ${orderId}
      UNION
      SELECT p."creditNoteId" FROM "InvoicePayment" p JOIN "Invoice" i ON i.id = p."invoiceId"
        WHERE i."orderId" = ${orderId} AND p."creditNoteId" IS NOT NULL
    ) ORDER BY id FOR UPDATE`;
}

/**
 * The send-time sweep's FIRST statements: the invoice (with its Order), then every live note of the
 * customer, so the sweep's candidate read sees committed balances only.
 */
export async function lockCustomerCreditsForSweep(
  tx: any,
  invoiceId: string,
  customerId: string,
): Promise<void> {
  await lockInvoiceForCredit(tx, invoiceId);
  await tx.$executeRaw`SELECT id FROM "CreditNote" WHERE "customerId" = ${customerId} AND status <> 'VOID' ORDER BY id FOR UPDATE`;
}
