/**
 * SA-1101 A-3 (B1 + N1): "Deliver again" on a REFUSED order, the one place that moves it back to CONFIRMED.
 *
 * A stop close leaves a REFUSED order linked to the stop that refused it (`routeRunId` / `routeRunStopId`), and
 * every way back onto a route needs that link to be null (createRun's sweep, the trip builder, the run-terminal
 * release). So the move is three things in ONE transaction, under the Order row lock the return create also takes:
 *   1. N1: refuse while the order has a live return (returns/live-return-guard.ts; the way back is the return's own
 *      cancel). The reason is stated there: order stock books once and a return books its own credit.
 *   2. B1: classify the link and clear it. A COMPLETED stop's link, or a bare link to a COMPLETED / CANCELLED run, is
 *      cleared. Anything else (a stop that is not COMPLETED, an active bare run, a row that cannot be read) is a
 *      409 ORDER_RUN_LINK_CHANGED with nothing written: a refusal cannot produce that state, so it is never guessed.
 *   3. One compare-and-set on the status and the link exactly as read; a miss is the same 409.
 *
 * Not `releaseFinishedRunLink`: that needs the whole run finished, and a refusal leaves the stop COMPLETED while the
 * run may still be IN_PROGRESS (the office can re-deliver the same day). The stop's REFUSED DeliveryMutation rows stay
 * (history, they count 0); line status, deliveredQty and deliveredAt need no reset (a close never writes them).
 */
import { ConflictException } from "@nestjs/common";
import { OrderStatus, RouteRunStatus, RouteRunStopStatus } from "@prisma/client";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { assertNoLiveReturn } from "../returns/live-return-guard";
import type { buildStatusUpdateData } from "./order-status-claim";

type Tx = {
  $executeRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
  order: {
    findFirst: (args: any) => Promise<any>;
    updateMany: (args: any) => Promise<{ count: number }>;
  };
  return: { count: (args: any) => Promise<number> };
};

const linkChanged = () =>
  new ConflictException({
    code: API_ERROR_CODES.ORDER_RUN_LINK_CHANGED,
    message: "This order's delivery run changed. Reload and try again.",
  });

const FINISHED_RUN: RouteRunStatus[] = [RouteRunStatus.COMPLETED, RouteRunStatus.CANCELLED];

export async function deliverAgainInTx(
  tx: Tx,
  orderId: string,
  data: ReturnType<typeof buildStatusUpdateData>,
) {
  await tx.$executeRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
  const order = await tx.order.findFirst({
    where: { id: orderId },
    select: {
      id: true,
      status: true,
      routeRunId: true,
      routeRunStopId: true,
      routeRunStop: { select: { status: true } },
      routeRun: { select: { status: true } },
    },
  });
  // Another change won the race for the status: the same answer as the generic status write.
  if (!order || order.status !== OrderStatus.REFUSED) {
    throw new ConflictException({
      code: API_ERROR_CODES.ORDER_CHANGED_DURING_EDIT,
      message:
        "The order's status changed while this change was being made — review it and try again.",
    });
  }

  await assertNoLiveReturn(
    tx,
    [orderId],
    "This order has a return. To deliver it again, cancel the return first, or create a new order.",
  );

  const hasStop = order.routeRunStopId != null;
  const hasRun = order.routeRunId != null;
  if (hasStop && order.routeRunStop?.status !== RouteRunStopStatus.COMPLETED) throw linkChanged();
  if (hasStop && hasRun && order.routeRun == null) throw linkChanged(); // a run we cannot read is never guessed at
  if (!hasStop && hasRun && !FINISHED_RUN.includes(order.routeRun?.status)) throw linkChanged();

  const moved = await tx.order.updateMany({
    where: {
      id: orderId,
      status: OrderStatus.REFUSED,
      routeRunId: order.routeRunId,
      routeRunStopId: order.routeRunStopId,
    },
    data: { ...data, ...(hasStop || hasRun ? { routeRunId: null, routeRunStopId: null } : {}) },
  });
  if (moved.count === 0) throw linkChanged();
  return tx.order.findFirst({ where: { id: orderId } });
}
