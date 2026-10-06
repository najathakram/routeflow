import { Prisma } from "@prisma/client";

/** The one method every helper needs: the caller's transaction client, or an op-log double. */
type LockTx = Pick<Prisma.TransactionClient, "$executeRaw">;

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
 *
 * Every statement is tenant-scoped (`"tenantId" = …`, as credit-notes.service `create` and
 * line-credit-headroom are): an id that belongs to another tenant can't lock, and so stall, that
 * tenant's rows. A null tenant (the documented unwrapped-tx case — settleOrderCreditsInTx's own
 * default) locks on the id alone, exactly as orders.service's Order lock does.
 */

/** The given notes, in id order. */
export async function lockCreditNotes(
  tx: LockTx,
  tenantId: string | null,
  ids: Array<string | null | undefined>,
): Promise<void> {
  const sorted = [...new Set(ids.filter((id): id is string => !!id))].sort();
  if (sorted.length === 0) return;
  await tx.$executeRaw`SELECT id FROM "CreditNote" WHERE id IN (${Prisma.join(sorted)}) AND (${tenantId}::text IS NULL OR "tenantId" = ${tenantId}) ORDER BY id FOR UPDATE`;
}

/** An invoice's Order (when it has one), then the invoice: the SA-214 prefix of a credit write. */
export async function lockInvoiceForCredit(
  tx: LockTx,
  tenantId: string | null,
  invoiceId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT id FROM "Order" WHERE id = (SELECT "orderId" FROM "Invoice" WHERE id = ${invoiceId} AND (${tenantId}::text IS NULL OR "tenantId" = ${tenantId})) AND (${tenantId}::text IS NULL OR "tenantId" = ${tenantId}) FOR UPDATE`;
  await tx.$executeRaw`SELECT id FROM "Invoice" WHERE id = ${invoiceId} AND (${tenantId}::text IS NULL OR "tenantId" = ${tenantId}) FOR UPDATE`;
}

/**
 * `settleOrderCreditsInTx`'s FIRST statements: this Order, every invoice of the order, then every
 * note the settle can touch — the notes its intents name and the notes already paying its invoices
 * (the shrink pass restores those).
 */
export async function lockOrderCreditSettle(
  tx: LockTx,
  tenantId: string | null,
  orderId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT id FROM "Order" WHERE id = ${orderId} AND (${tenantId}::text IS NULL OR "tenantId" = ${tenantId}) FOR UPDATE`;
  await tx.$executeRaw`SELECT id FROM "Invoice" WHERE "orderId" = ${orderId} AND (${tenantId}::text IS NULL OR "tenantId" = ${tenantId}) ORDER BY id FOR UPDATE`;
  await tx.$executeRaw`SELECT id FROM "CreditNote" WHERE id IN (
      SELECT "creditNoteId" FROM "OrderCreditNote" WHERE "orderId" = ${orderId}
      UNION
      SELECT p."creditNoteId" FROM "InvoicePayment" p JOIN "Invoice" i ON i.id = p."invoiceId"
        WHERE i."orderId" = ${orderId} AND p."creditNoteId" IS NOT NULL
    ) AND (${tenantId}::text IS NULL OR "tenantId" = ${tenantId}) ORDER BY id FOR UPDATE`;
}

/**
 * The send-time sweep's FIRST statements: the invoice (with its Order), then every live note of the
 * customer, so the sweep's candidate read sees committed balances only.
 */
export async function lockCustomerCreditsForSweep(
  tx: LockTx,
  tenantId: string | null,
  invoiceId: string,
  customerId: string,
): Promise<void> {
  await lockInvoiceForCredit(tx, tenantId, invoiceId);
  await tx.$executeRaw`SELECT id FROM "CreditNote" WHERE "customerId" = ${customerId} AND status <> 'VOID' AND (${tenantId}::text IS NULL OR "tenantId" = ${tenantId}) ORDER BY id FOR UPDATE`;
}

/**
 * B1052 (deadlock fold-in): markSent's credit locks, taken ONCE and up front, after it holds the
 * Order and the Invoice. Settle locks the notes its order touches and the sweep then locks the
 * customer's whole live set; two sends taking those as two passes could each hold the other's next
 * note. Here: the order's invoices (SA-214: Order → Invoice), then the customer's live notes UNION
 * settle's subset in ONE id-ordered statement, so every later settle / sweep lock is a no-op on a
 * row this transaction already holds. (Settle's subset can include a VOID note — a restore may
 * touch one — which is why it rides along rather than being filtered.) `locked` is the row
 * markSent just locked and re-read (SA-404), never the caller's pre-tx read.
 */
export async function lockCreditsForSend(
  tx: LockTx,
  tenantId: string | null,
  locked: { orderId: string | null; customerId: string },
): Promise<void> {
  const { orderId, customerId } = locked;
  if (!orderId) {
    await tx.$executeRaw`SELECT id FROM "CreditNote" WHERE "customerId" = ${customerId} AND status <> 'VOID' AND (${tenantId}::text IS NULL OR "tenantId" = ${tenantId}) ORDER BY id FOR UPDATE`;
    return;
  }
  await tx.$executeRaw`SELECT id FROM "Invoice" WHERE "orderId" = ${orderId} AND (${tenantId}::text IS NULL OR "tenantId" = ${tenantId}) ORDER BY id FOR UPDATE`;
  await tx.$executeRaw`SELECT id FROM "CreditNote" WHERE ("customerId" = ${customerId} AND status <> 'VOID' OR id IN (
      SELECT "creditNoteId" FROM "OrderCreditNote" WHERE "orderId" = ${orderId}
      UNION
      SELECT p."creditNoteId" FROM "InvoicePayment" p JOIN "Invoice" i ON i.id = p."invoiceId"
        WHERE i."orderId" = ${orderId} AND p."creditNoteId" IS NOT NULL
    )) AND (${tenantId}::text IS NULL OR "tenantId" = ${tenantId}) ORDER BY id FOR UPDATE`;
}
