import { ConflictException, Logger } from "@nestjs/common";
import { OrderStatus } from "@prisma/client";
import { lockProductsForStock } from "../common/product-locks";
import { stockTxRetryState } from "../common/tx-retry";
import { CANCELLABLE_FROM } from "../orders/order-status-transitions";
import { STOCK_SETTLE_SELECT, settleStockForEdit } from "../orders/order-stock";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the interactive tx client
type Tx = any;

/**
 * B1241: a customer delete / purge destroys the customer's orders, and an order that booked stock
 * must hand it back first, or the shelf under-counts for good. Runs INSIDE the delete transaction,
 * before any write, through the SAME settle path an order cancel uses (`settleStockForEdit` with an
 * empty final line set, event "DELETE"), so the SALE movement, the box/piece sizing and the delivered
 * floor are the cancel's own (same rule as `lockDeleteLines`, B284).
 *
 * Which orders: those a cancel would credit: `CANCELLABLE_FROM` minus DRAFT (a DRAFT never booked).
 * CANCELLED was credited by its cancel, and a DELIVERED order's goods are gone (master behaviour kept).
 *
 * Lock order (common/product-locks.ts): domain rows first (Return, then Order, each in id order, the
 * same Return -> Order order the return approve paths take), the status is read UNDER the Order lock,
 * then ONE `lockProductsForStock` over every product of every live order (so the product rows are
 * taken in the house rank, never one order's set after another's), then the per-order settles (their
 * own product lock is a no-op re-take). Nothing else is locked or written before this returns.
 *
 * CALLERS' OBLIGATION: call it BEFORE taking any row lock in the delete tx (the guards before it are plain
 * reads), or the Return -> Order -> Products order above is broken. It returns the ids of the Order rows it
 * locked; the caller MUST pass them to `assertOrdersUnchanged` against the orders it is about to delete, because
 * an order committed after this lock (READ COMMITTED re-reads) was never credited and must not be destroyed.
 *
 * `lockProductsForStock` leaves `lock_timeout` at 5 s for the rest of the tx; it is put back to its prior value
 * before returning (the deletes after it keep the wait they always had), and a lock wait that gives up here
 * (55P03, or the tx budget P2028) is a 409 "retry", never a 500.
 */
export async function releaseLiveOrderStockInTx(
  tx: Tx,
  tenantId: string | null | undefined,
  logger: Logger,
  customerIds: string[],
): Promise<string[]> {
  const prior = (await tx.$queryRaw`SELECT current_setting('lock_timeout') AS v`)?.[0]?.v;
  await tx.$queryRaw`SELECT id FROM "Return" WHERE "customerId" = ANY(${customerIds}::text[]) ORDER BY id FOR UPDATE`;
  const locked: Array<{ id: string }> =
    (await tx.$queryRaw`SELECT id FROM "Order" WHERE "customerId" = ANY(${customerIds}::text[]) ORDER BY id FOR UPDATE`) ??
    [];
  const lockedIds = locked.map((o) => o.id);
  if (lockedIds.length === 0) return lockedIds;

  // The status under the lock, never an unlocked read from before it.
  const rows: Array<{ id: string; status: OrderStatus }> = await tx.order.findMany({
    where: { id: { in: lockedIds } },
    select: { id: true, status: true },
    orderBy: { id: "asc" },
  });
  const live = rows.filter(
    (o) => o.status !== OrderStatus.DRAFT && CANCELLABLE_FROM.includes(o.status),
  );
  if (live.length === 0) return lockedIds;

  const lines: Array<{ orderId: string; productId: string | null }> = await tx.orderItem.findMany({
    where: { orderId: { in: live.map((o) => o.id) }, status: { not: "CANCELLED" } },
    select: { orderId: true, ...STOCK_SETTLE_SELECT },
  });
  try {
    await lockProductsForStock(
      tx,
      tenantId,
      lines.flatMap((l) => (l.productId ? [l.productId] : [])),
    );
    for (const order of live) {
      await settleStockForEdit(
        { logger, tenantId },
        tx,
        order,
        lines.filter((l) => l.orderId === order.id) as never,
        [],
        undefined,
        { notes: "DELETE" },
      );
    }
  } catch (e) {
    const state = stockTxRetryState(e);
    if (state === "55P03" || state === "P2028")
      throw new ConflictException(
        "Stock is being updated for this customer's orders — nothing was deleted; please retry.",
      );
    throw e;
  }
  if (typeof prior === "string")
    await tx.$executeRaw`SELECT set_config('lock_timeout', ${prior}, true)`;
  return lockedIds;
}

/**
 * B1241 (compare-and-set, like `deleteNonBlockingInvoicesCas`): the orders about to be deleted must be exactly
 * the ones `releaseLiveOrderStockInTx` locked and credited. A create that committed after that lock would
 * otherwise be destroyed with its booked stock never returned: 409, rollback, nothing deleted.
 */
export function assertOrdersUnchanged(deleting: string[], locked: string[]): void {
  const have = new Set(locked);
  const del = new Set(deleting);
  if (
    del.size !== deleting.length ||
    del.size !== have.size ||
    deleting.some((id) => !have.has(id))
  )
    throw new ConflictException(
      "Customer orders changed while they were being deleted — nothing was deleted; please retry.",
    );
}
