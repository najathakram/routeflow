import { NotificationEvent, OrderStatus } from "@prisma/client";
import { orderOutcomeAfterStop, type StopOrderOutcome } from "@routeflow/pricing";
import { formatDate, formatMoney } from "../messaging/messaging.helpers";
import type { MessagingService } from "../messaging/messaging.service";
import { NON_ROUTABLE_ORDER_STATUSES } from "./routes.constants";

/**
 * SA-1101 §2.2: the ONE step that decides what a stop close makes each order, shared by `completeStop` and
 * `completeWithPayment` (retiring the bare `/complete` close later is just deleting one caller). It replaces the
 * blind "every routable order becomes DELIVERED" write and the pre-transaction-status notice loops.
 */

export interface StopOrderRef {
  id: string;
  status: OrderStatus;
  customerId: string;
  orderNumber: string | null;
  total: unknown;
}

/**
 * Runs in the caller's transaction, AFTER the `deliveredQty` recompute. Reads the lines of every order on the
 * stop that is not DRAFT or terminal (one `findMany`), decides each order's outcome from them
 * (`orderOutcomeAfterStop`), and writes both statuses (one `updateMany` each, behind the existing
 * `NON_ROUTABLE_ORDER_STATUSES` guard):
 *   DELIVERED -> `deliveredAt` = the close's time; REFUSED -> `deliveredAt` null.
 * Returns the outcome per order; the notice loops read THIS map, never the pre-transaction status.
 */
export async function applyStopOutcomes(
  tx: any,
  stopOrders: ReadonlyArray<{ id: string; status: OrderStatus }>,
  closedAt: Date,
): Promise<Map<string, StopOrderOutcome>> {
  const outcomes = new Map<string, StopOrderOutcome>();
  const candidates = stopOrders.filter((o) => !NON_ROUTABLE_ORDER_STATUSES.includes(o.status));
  if (candidates.length === 0) return outcomes;

  const lines: { orderId: string; status: string | null; deliveredQty: unknown }[] =
    await tx.orderItem.findMany({
      where: { orderId: { in: candidates.map((o) => o.id) } },
      select: { orderId: true, status: true, deliveredQty: true },
    });
  const linesByOrder = new Map<
    string,
    { status: string | null; deliveredQty: number | string }[]
  >();
  for (const l of lines) {
    const list = linesByOrder.get(l.orderId) ?? [];
    list.push({ status: l.status, deliveredQty: l.deliveredQty as number | string });
    linesByOrder.set(l.orderId, list);
  }
  for (const o of candidates) {
    outcomes.set(o.id, orderOutcomeAfterStop(linesByOrder.get(o.id) ?? []));
  }

  const idsFor = (outcome: StopOrderOutcome) =>
    candidates.filter((o) => outcomes.get(o.id) === outcome).map((o) => o.id);
  const delivered = idsFor("DELIVERED");
  const refused = idsFor("REFUSED");
  if (delivered.length > 0) {
    await tx.order.updateMany({
      where: { id: { in: delivered }, status: { notIn: NON_ROUTABLE_ORDER_STATUSES } },
      data: { status: OrderStatus.DELIVERED, deliveredAt: closedAt },
    });
  }
  if (refused.length > 0) {
    await tx.order.updateMany({
      where: { id: { in: refused }, status: { notIn: NON_ROUTABLE_ORDER_STATUSES } },
      data: { status: OrderStatus.REFUSED, deliveredAt: null },
    });
  }
  return outcomes;
}

/**
 * After the commit, fire-and-forget (P6-5): one notice per order the close flipped, of ITS kind. A refused order
 * sends `ORDER_REFUSED` with no total; a delivered one sends `DELIVERED` as before; an order not in the map was
 * already terminal and sends nothing. `totals` is the post-reconcile invoice total per order (B663/I2); an order
 * without one falls back to the order's own total.
 */
export function notifyStopOutcomes(
  messaging: Pick<MessagingService, "notifyEvent">,
  outcomes: ReadonlyMap<string, StopOrderOutcome>,
  stopOrders: readonly StopOrderRef[],
  senderId: string | null,
  closedAt: Date,
  totals?: ReadonlyMap<string, number>,
): void {
  for (const o of stopOrders) {
    const outcome = outcomes.get(o.id);
    if (!outcome) continue;
    const refused = outcome === "REFUSED";
    messaging
      .notifyEvent(refused ? NotificationEvent.ORDER_REFUSED : NotificationEvent.DELIVERED, {
        customerId: o.customerId,
        senderId,
        vars: refused
          ? { orderNumber: o.orderNumber ?? "" }
          : {
              orderNumber: o.orderNumber ?? "",
              orderTotal: formatMoney(totals?.get(o.id) ?? Number(o.total)),
              deliveredAt: formatDate(closedAt),
            },
      })
      ?.catch(() => {});
  }
}
