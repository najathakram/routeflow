import { InvoiceStatus, OrderStatus } from "@prisma/client";
import { roundMoney } from "@routeflow/pricing";

export interface DeliveredReconcileDeps {
  reconcileDeliveredOrdersInTx: (
    tx: any,
    orderIds: string[],
    reconcileOrderIds: string[],
  ) => Promise<void>;
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
  deps: DeliveredReconcileDeps,
  tx: any,
  stopOrders: ReadonlyArray<{ id: string; status: OrderStatus }>,
  deliveredOrderIdSet: ReadonlySet<string>,
): Promise<string[]> {
  const deliveredOrderIds = stopOrders
    // DELIVERED stays in (the office may have marked it already; it keeps its invoice), but a
    // DRAFT is not a commitment yet: never invoiced or paid at the door.
    .filter((o) => o.status !== OrderStatus.CANCELLED && o.status !== OrderStatus.DRAFT)
    .map((o) => o.id);
  if (deliveredOrderIds.length > 0) {
    await deps.reconcileDeliveredOrdersInTx(tx, deliveredOrderIds, Array.from(deliveredOrderIdSet));
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
 * back to the pre-tx order total only when an order has no non-void invoice at all
 * (shouldn't happen for a routed order, but never silently notify a wrong amount).
 */
export async function resolvePostReconcileOrderTotals(
  db: InvoiceTotalsDb,
  routableOrderIds: readonly string[],
): Promise<Map<string, number>> {
  const invoices =
    routableOrderIds.length > 0
      ? await db.invoice.findMany({
          where: {
            orderId: { in: routableOrderIds as string[] },
            status: { not: InvoiceStatus.VOID },
          },
          select: { orderId: true, total: true },
        })
      : [];
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
