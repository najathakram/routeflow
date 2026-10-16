import { Logger } from "@nestjs/common";
import { OrderStatus } from "@prisma/client";
import { lockProductsForStock } from "../common/product-locks";
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
 */
export async function releaseLiveOrderStockInTx(
  tx: Tx,
  tenantId: string | null | undefined,
  logger: Logger,
  customerIds: string[],
): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "Return" WHERE "customerId" = ANY(${customerIds}::text[]) ORDER BY id FOR UPDATE`;
  const locked: Array<{ id: string }> =
    (await tx.$queryRaw`SELECT id FROM "Order" WHERE "customerId" = ANY(${customerIds}::text[]) ORDER BY id FOR UPDATE`) ??
    [];
  if (locked.length === 0) return;

  // The status under the lock, never an unlocked read from before it.
  const rows: Array<{ id: string; status: OrderStatus }> = await tx.order.findMany({
    where: { id: { in: locked.map((o) => o.id) } },
    select: { id: true, status: true },
    orderBy: { id: "asc" },
  });
  const live = rows.filter(
    (o) => o.status !== OrderStatus.DRAFT && CANCELLABLE_FROM.includes(o.status),
  );
  if (live.length === 0) return;

  const lines: Array<{ orderId: string; productId: string | null }> = await tx.orderItem.findMany({
    where: { orderId: { in: live.map((o) => o.id) }, status: { not: "CANCELLED" } },
    select: { orderId: true, ...STOCK_SETTLE_SELECT },
  });
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
}
