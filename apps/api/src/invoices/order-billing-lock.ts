import { Prisma } from "@prisma/client";
import { lockOrderRow } from "../credit-notes/credit-note-locks";
import { AfterCommit } from "../common/after-commit";

/**
 * SA-760 R-1: the ONE lock order for every order<->invoice billing-state writer
 * (reconcileOrderDraftInvoice, reconcileOrderDeliveredInvoices, rebuildIssuedDepositMirrorOnDelivery,
 * resyncOrderInvoicesForEdit and, through them, rebuildSiblingDrafts).
 *
 *   1. the Order row FOR UPDATE (`lockOrderRow`, SA-706: before any FK insert takes KEY SHARE on it);
 *   2. the order's invoices FOR UPDATE, id-sorted in ONE statement (SA-218: Order -> Invoice ->
 *      CreditNote), plus any extra ids the caller names;
 *   3. only THEN does the writer re-read the sole-draft check, the lines and `invoicedQty` and write.
 *
 * Without it the writers ran the sole-draft check and the `deleteMany` -> `update` on the unlocked
 * `forTenant()` client: two concurrent Mark Delivered doubled the lines (B1096) and a partial created
 * between the check and the write was overwritten (Gap B, GH#2684). Every invoice insert for an order
 * (createPartialFromOrder, createSplitInvoices) already takes the Order row first, so holding it here
 * means no invoice can appear while the writer decides.
 *
 * Advisory before rows (SA-760 rule 3): `withOrderRecomputeLock` (family `order-merge`, key = the
 * order) is taken BEFORE the Order row, never after. None of the writers above calls
 * `recomputeOrderFromInvoices`; its three callers run after their own transaction committed
 * (order-lock-callers.guard.spec.ts pins both).
 *
 * Re-locking a row this transaction already holds is a no-op, so a caller that holds the Order
 * (the merge winner, completeWithPayment's stop-order lock) pays nothing for the second call.
 */

/** The transaction client a billing writer runs on (tenantTransaction hands one to its callback). */
export type OrderBillingTx = Prisma.TransactionClient;

/** The statements only: an op-log double or any tx client with `$executeRaw` will do. */
type BillingLockTx = { $executeRaw: (...args: any[]) => unknown };

export async function withOrderBillingLock(
  tx: BillingLockTx,
  tenantId: string | null,
  orderId: string,
  extraInvoiceIds: readonly string[] = [],
): Promise<void> {
  await lockOrderRow(tx as Parameters<typeof lockOrderRow>[0], tenantId, orderId);
  const extra = [...new Set(extraInvoiceIds)].sort();
  if (extra.length === 0) {
    await tx.$executeRaw`SELECT id FROM "Invoice" WHERE "orderId" = ${orderId} AND (${tenantId}::text IS NULL OR "tenantId" = ${tenantId}) ORDER BY id FOR UPDATE`;
    return;
  }
  await tx.$executeRaw`SELECT id FROM "Invoice" WHERE ("orderId" = ${orderId} OR id IN (${Prisma.join(extra)})) AND (${tenantId}::text IS NULL OR "tenantId" = ${tenantId}) ORDER BY id FOR UPDATE`;
}

/**
 * Run `fn` under the billing lock. With a caller `tx` the locks are taken on it (the caller owns the
 * commit and any realtime queue); with none a `tenantTransaction` is opened FIRST, so the locks and
 * every write share one transaction (the unlocked `forTenant()` path is gone).
 */
export async function inOrderBillingTx<T>(
  prisma: {
    getTenantId(): string | null;
    tenantTransaction<R>(fn: (tx: any) => Promise<R>, options?: { timeout?: number }): Promise<R>;
  },
  tx: OrderBillingTx | undefined,
  orderId: string,
  fn: (tx: OrderBillingTx) => Promise<T>,
): Promise<T> {
  const tenantId = prisma.getTenantId() ?? null;
  if (tx) {
    await withOrderBillingLock(tx, tenantId, orderId);
    return fn(tx);
  }
  return prisma.tenantTransaction(
    async (own) => {
      await withOrderBillingLock(own, tenantId, orderId);
      return fn(own);
    },
    { timeout: 15_000 },
  );
}

/**
 * `inOrderBillingTx` for a writer that also emits realtime events: with a caller `tx` the caller's
 * AfterCommit queue is used (gatewayFor refuses an emit without one, #2175); with none the writer's
 * own transaction gets a fresh queue that is flushed only once that transaction has committed (a
 * rejected transaction flushes nothing, and a retried attempt starts clean).
 */
export async function inOrderBillingTxAfter<T>(
  prisma: Parameters<typeof inOrderBillingTx>[0],
  tx: OrderBillingTx | undefined,
  after: AfterCommit | undefined,
  orderId: string,
  fn: (tx: OrderBillingTx, after: AfterCommit | undefined) => Promise<T>,
): Promise<T> {
  if (tx) return inOrderBillingTx(prisma, tx, orderId, (t) => fn(t, after));
  const own = new AfterCommit();
  const result = await inOrderBillingTx(prisma, undefined, orderId, (t) => {
    own.reset();
    return fn(t, own);
  });
  own.flush();
  return result;
}
