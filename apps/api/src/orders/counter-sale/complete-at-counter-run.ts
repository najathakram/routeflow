import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../../common/api-error-codes";
import { AUDIT_ACTIONS } from "../../audit/audit-actions.constant";
import { claimStopStatusChange, lockStopsOrdersForRelease } from "../../routes/delivery-lines.util";

/**
 * I-120 SA-861 R8/R9, the owner's 7a answers as SA-913 ruled them, judged from the row and the request BEFORE any write:
 *  - R9: an order shipped with the carrier (a SHIP order with `shippedAt`, or OUT_FOR_DELIVERY on SHIP) is refused, 409
 *    COUNTER_COMPLETE_SHIPPED.
 *  - R8: an order on a driver's SCHEDULED / IN_PROGRESS run. Its stop started (IN_PROGRESS, COMPLETED), or a bare run link
 *    with no stop (a driver-created order: there is no stop to take it off): 409 COUNTER_COMPLETE_STOP_STARTED, with or
 *    without the confirm. A PENDING stop, or one the office SKIPPED (nothing delivered): without `takeOffRun: true`, 409
 *    COUNTER_COMPLETE_ON_RUN carrying `driverName` and `runId` for the client's confirm; with it, null here and
 *    `activeRunLink` names the link `takeOrderOffRun` releases.
 * null = nothing to refuse. An OUT_FOR_DELIVERY order on no run is not refused: the switch's caller-pinned option takes it.
 */
type Run = {
  id?: string;
  status?: string | null;
  driver?: { contactName?: string | null } | null;
} | null;
export type RunOrder = {
  status: string;
  fulfillPath: string;
  shippedAt?: Date | string | null;
  routeRunId?: string | null;
  routeRunStopId?: string | null;
  routeRun?: Run;
  routeRunStop?: { status?: string | null; routeRun?: Run } | null;
};

const ACTIVE_RUN = new Set(["SCHEDULED", "IN_PROGRESS"]);
/** SA-913 (a) 2: the stop statuses a take-off may release from (nothing was delivered there) */
const NOT_STARTED = new Set(["PENDING", "SKIPPED"]);
/** SA-913 (b): the one copy an emptied stop is skipped with */
export const COMPLETED_AT_COUNTER_SKIP_REASON = "Completed at counter";
const STOP_STARTED_MESSAGE = "The driver has started this stop. Finish it on the route.";

function activeRun(order: RunOrder): Run {
  const run = order.routeRunStop?.routeRun ?? order.routeRun ?? null;
  return run?.status && ACTIVE_RUN.has(run.status) ? run : null;
}

/** The run link the engine takes off the run (SA-913 R8), or null: no active run (a resume after the step skips it). */
export function activeRunLink(order: RunOrder): { runId: string; stopId: string } | null {
  if (!activeRun(order) || !order.routeRunId || !order.routeRunStopId) return null;
  return { runId: order.routeRunId, stopId: order.routeRunStopId };
}

export function completeAtCounterRunRefusal(
  order: RunOrder,
  takeOffRun: boolean,
): ConflictException | null {
  const shipped =
    order.fulfillPath === "SHIP" && (!!order.shippedAt || order.status === "OUT_FOR_DELIVERY");
  if (shipped) {
    return new ConflictException({
      code: API_ERROR_CODES.COUNTER_COMPLETE_SHIPPED,
      message: "This order has shipped with the carrier.",
    });
  }
  const run = activeRun(order);
  if (!run) return null;
  if (!order.routeRunStopId || !NOT_STARTED.has(order.routeRunStop?.status ?? "")) {
    return new ConflictException({
      code: API_ERROR_CODES.COUNTER_COMPLETE_STOP_STARTED,
      message: STOP_STARTED_MESSAGE,
    });
  }
  if (takeOffRun) return null;
  const driverName = run.driver?.contactName ?? null;
  return new ConflictException({
    code: API_ERROR_CODES.COUNTER_COMPLETE_ON_RUN,
    message: driverName
      ? `This order is on ${driverName}'s run. Completing it here takes it off the run.`
      : "This order is on a delivery run. Completing it here takes it off the run.",
    driverName,
    runId: order.routeRunId ?? run.id ?? null,
  });
}

const linkChanged = () =>
  new ConflictException({
    code: API_ERROR_CODES.ORDER_RUN_LINK_CHANGED,
    message:
      "This order's delivery run changed while you were completing it. Reload and try again.",
  });

/**
 * SA-913 (a, b, d): take ONE order off a driver's live run, on the caller's tx, after the claim and before the path switch,
 * in the house lock order (SA-706f: Orders → stop → run):
 *  1. the seen stop's Orders FOR UPDATE by id (ours included), so "no other order left" is true when it is decided;
 *  2. the stop row FOR UPDATE: still on the seen run and PENDING or SKIPPED, else COUNTER_COMPLETE_STOP_STARTED. The row lock is
 *     the serialization with the driver's IN_PROGRESS CAS (a status subquery inside one updateMany is not, under READ COMMITTED);
 *  3. the run row FOR UPDATE: still SCHEDULED / IN_PROGRESS, else ORDER_RUN_LINK_CHANGED (the retry takes R12's path);
 *  4. the CAS unlink of our order (B692 class); a count of 0 is ORDER_RUN_LINK_CHANGED.
 * An emptied PENDING stop becomes SKIPPED ("Completed at counter") through the house stop-status writer's CAS; a stop with the
 * customer's other orders is left alone. The status is NOT touched (no OUT_FOR_DELIVERY → CONFIRMED, SA-913 c). One audit
 * row. Every refusal throws, so nothing in the tx is written.
 */
export async function takeOrderOffRun(
  tx: any,
  link: { orderId: string; runId: string; stopId: string },
  actor: { tenantId: string; userId: string },
): Promise<{ stopSkipped: boolean }> {
  const onStop = await lockStopsOrdersForRelease(tx, [link.stopId]);
  if (!onStop.includes(link.orderId)) throw linkChanged();
  const [stop]: Array<{ status: string; routeRunId: string }> = await tx.$queryRaw`
    SELECT status::text AS status, "routeRunId" FROM "RouteRunStop" WHERE id = ${link.stopId} FOR UPDATE`;
  if (!stop || stop.routeRunId !== link.runId) throw linkChanged();
  if (!NOT_STARTED.has(stop.status)) {
    throw new ConflictException({
      code: API_ERROR_CODES.COUNTER_COMPLETE_STOP_STARTED,
      message: STOP_STARTED_MESSAGE,
    });
  }
  const [run]: Array<{ status: string; driverId: string | null }> = await tx.$queryRaw`
    SELECT status::text AS status, "driverId" FROM "RouteRun" WHERE id = ${link.runId} FOR UPDATE`;
  if (!run || !ACTIVE_RUN.has(run.status)) throw linkChanged();
  const { count } = await tx.order.updateMany({
    where: { id: link.orderId, routeRunStopId: link.stopId },
    data: { routeRunId: null, routeRunStopId: null },
  });
  if (count === 0) throw linkChanged();
  const stopSkipped = stop.status === "PENDING" && onStop.length === 1;
  if (stopSkipped) {
    await claimStopStatusChange(tx, link.stopId, {
      status: "SKIPPED",
      skipReason: COMPLETED_AT_COUNTER_SKIP_REASON,
    });
  }
  await tx.auditLog.create({
    data: {
      tenantId: actor.tenantId,
      userId: actor.userId,
      action: AUDIT_ACTIONS.COUNTER_COMPLETE_TAKEN_OFF_RUN,
      entityType: "Order",
      entityId: link.orderId,
      meta: { ...link, driverId: run.driverId, stopSkipped },
    },
  });
  return { stopSkipped };
}
