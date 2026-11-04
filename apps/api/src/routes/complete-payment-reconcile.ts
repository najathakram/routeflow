import { InvoiceStatus, OrderStatus } from "@prisma/client";
import { roundMoney, STOP_QTY_EPS } from "@routeflow/pricing";
import { lockOrderRows } from "../credit-notes/credit-note-locks";
import { BadRequestException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { assertDeliveriesFitStop } from "./delivery-lines.util";
import { deliveredSoFarForLine, fetchEvidenceByLine, lineRemaining } from "./delivered-so-far";
import { NON_ROUTABLE_ORDER_STATUSES } from "./routes.constants";

export interface StopReconcileDeps {
  // Structurally matches InvoicesService itself — callers pass the service instance
  // directly (correct `this` on the method: it's invoked as deps.reconcileDeliveredOrdersInTx(...)).
  reconcileDeliveredOrdersInTx(
    tx: any,
    orderIds: string[],
    reconcileOrderIds: string[],
    userId?: string,
  ): Promise<void>;
}

/**
 * SA-706c: the FIRST statements of `completeWithPayment`'s transaction. The stop's Orders are locked
 * FOR UPDATE, id-ordered, BEFORE any write: the delivery-mutation insert below takes an FK KEY SHARE
 * on its Order, the invoice create (createInvoiceFromOrder with this tx) takes another, and settle's
 * Order lock then upgrades it, so a concurrent partial / split create or Mark Delivered on one of the
 * same orders could otherwise deadlock (40P01). Tenant-less on purpose: the ids come from the
 * caller's tenant-scoped stop read. Then the delivery-fit assertion (a read) runs as before.
 */
export async function lockStopOrdersAndFit(
  tx: any,
  stopId: string,
  stopOrders: ReadonlyArray<{ id: string }>,
  deliveries: Parameters<typeof assertDeliveriesFitStop>[3],
): Promise<void> {
  await lockOrderRows(
    tx,
    null,
    stopOrders.map((o) => o.id),
  );
  await assertDeliveriesFitStop(tx, stopId, stopOrders, deliveries);
  await assertEveryOpenLineCovered(tx, stopId, stopOrders, deliveries);
}

/**
 * SA-1101 §2.3 (B785): every line of a routable order on the stop that still has something to deliver must have an
 * entry in `deliveries`. Both clients send exactly those lines (an entry per line with something left, built from the
 * same remaining the server serves), so a close that misses one is a stale or hand-made payload: refused with a 400
 * before anything is written, because a blind close used to write DELIVERED over lines nobody counted. "Something
 * left" is `lineRemaining`, the figure the fit check above uses, so the two checks cannot disagree. An order whose
 * lines are all delivered or cancelled needs no entry.
 */
export async function assertEveryOpenLineCovered(
  tx: any,
  stopId: string,
  stopOrders: ReadonlyArray<{ id: string }>,
  deliveries: ReadonlyArray<{ orderItemId: string }> | undefined,
): Promise<void> {
  if (stopOrders.length === 0) return;
  const orderIds = stopOrders.map((o) => o.id);
  const lines: {
    id: string;
    orderId: string;
    qty: unknown;
    deliveredQty: unknown;
    status: string | null;
    order: { status: string } | null;
  }[] = await tx.orderItem.findMany({
    where: {
      orderId: { in: orderIds },
      status: { not: "CANCELLED" },
      order: { status: { notIn: NON_ROUTABLE_ORDER_STATUSES } },
    },
    select: {
      id: true,
      orderId: true,
      qty: true,
      deliveredQty: true,
      status: true,
      order: { select: { status: true } },
    },
  });
  if (lines.length === 0) return;
  const evidence = await fetchEvidenceByLine(tx, [...new Set(lines.map((l) => l.orderId))]);
  const entered = new Set((deliveries ?? []).map((d) => d.orderItemId));
  const missing = lines.filter(
    (l) =>
      !entered.has(l.id) &&
      lineRemaining({
        qty: l.qty,
        lineStatus: l.status,
        orderStatus: l.order?.status,
        deliveredSoFar: deliveredSoFarForLine(
          evidence[l.orderId]?.[l.id],
          stopId,
          l.deliveredQty,
          l.qty,
        ),
      }) > STOP_QTY_EPS,
  );
  if (missing.length === 0) return;
  throw new BadRequestException({
    code: API_ERROR_CODES.STOP_DELIVERY_LINES_MISSING,
    message: `Enter what was delivered for every line before finishing this stop (${missing.length} ${
      missing.length === 1 ? "line is" : "lines are"
    } missing).`,
  });
}

/**
 * B663: reconcile every delivered order's invoice onto the DELIVERED quantities,
 * UNCONDITIONALLY — a short or refused line must bill what was actually delivered
 * whether or not any payment was collected at the door (on-account completions send
 * no payment at all, and used to skip this entirely because it lived behind the
 * payment step). Returns the delivered order ids (DELIVERED stays in — the office may
 * have marked it already, it keeps its invoice; a DRAFT is not a commitment yet: never
 * invoiced or paid at the door) so `completeWithPayment`'s payment step reuses them.
 *
 * Lives outside routes.service.ts (size-ratchet: this file has no headroom for it) —
 * called from a one-line call site in `RoutesService.completeWithPayment`.
 */
export async function reconcileDeliveredStopOrders(
  deps: StopReconcileDeps,
  tx: any,
  stopOrders: ReadonlyArray<{ id: string; status: OrderStatus }>,
  deliveredOrderIdSet: ReadonlySet<string>,
  userId?: string,
): Promise<string[]> {
  const deliveredOrderIds = stopOrders
    // DELIVERED stays in (the office may have marked it already; it keeps its invoice), but a
    // DRAFT is not a commitment yet: never invoiced or paid at the door.
    .filter((o) => o.status !== OrderStatus.CANCELLED && o.status !== OrderStatus.DRAFT)
    .map((o) => o.id);
  if (deliveredOrderIds.length > 0) {
    await deps.reconcileDeliveredOrdersInTx(
      tx,
      deliveredOrderIds,
      Array.from(deliveredOrderIdSet),
      userId,
    );
  }
  return deliveredOrderIds;
}

export interface InvoiceTotalsDb {
  invoice: {
    findMany(args: any): Promise<Array<{ orderId: string | null; total: unknown }>>;
  };
}

/**
 * B663/I2: `Order.total` is the pre-transaction snapshot `completeWithPayment` read at
 * the top of the method (before the delivered-basis reconcile above ever ran) — it is
 * the FULL ordered total, not what a short or refused delivery actually bills. The
 * reconcile updates the order's non-void INVOICE totals, never `Order.total` itself
 * (`recomputeOrderFromInvoices`, the thing that would, is not in this call chain), so
 * the DELIVERED notification must read the invoice(s) fresh, post-transaction, falling
 * back to the pre-tx order total when an order has no non-void invoice at all (shouldn't
 * happen for a routed order, but never silently notify a wrong amount) OR when the
 * lookup itself throws — by this point the stop is already committed and saved
 * (fire-and-forget notification prep, post-tx), so a throw here must never surface as a
 * 500: the caller would see the stop fail to save even though it didn't, the idempotency
 * key would never get stored, and a retry would find "Stop is already completed".
 */
export async function resolvePostReconcileOrderTotals(
  db: InvoiceTotalsDb,
  routableOrderIds: readonly string[],
  logger?: { warn(message: string): void },
): Promise<Map<string, number>> {
  if (routableOrderIds.length === 0) return new Map();
  let invoices: Array<{ orderId: string | null; total: unknown }>;
  try {
    invoices = await db.invoice.findMany({
      where: { orderId: { in: routableOrderIds as string[] }, status: { not: InvoiceStatus.VOID } },
      select: { orderId: true, total: true },
    });
  } catch (err) {
    logger?.warn(
      `resolvePostReconcileOrderTotals: invoice lookup failed, notifying with pre-tx order totals: ${(err as Error)?.message}`,
    );
    return new Map();
  }
  const totalByOrder = new Map<string, number>();
  for (const inv of invoices) {
    if (!inv.orderId) continue;
    totalByOrder.set(
      inv.orderId,
      roundMoney((totalByOrder.get(inv.orderId) ?? 0) + Number(inv.total)),
    );
  }
  return totalByOrder;
}
