import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../../common/api-error-codes";

/**
 * I-120 SA-861 R8/R9, the owner's 7a answers (D-2026-10-23-counter-complete-and-real-money):
 *  - Q2 = A: an order already shipped with the carrier (a SHIP order with `shippedAt`, or OUT_FOR_DELIVERY on SHIP) is
 *    refused: "This order has shipped with the carrier."
 *  - Q1 = A: a delivery order already on a driver's run (a SCHEDULED / IN_PROGRESS run, or OUT_FOR_DELIVERY on ROUTE) is
 *    taken off the run in the same step, after a confirm that names the driver (`removeFromRun`). Without the confirm: 409
 *    COUNTER_COMPLETE_ON_RUN carrying `driverName`, for the client's confirm. Once the driver has started that stop
 *    (IN_PROGRESS, COMPLETED, SKIPPED): refused in every answer.
 * Judged from the row and the request BEFORE any write; null = nothing to refuse here. The confirmed removal itself waits on
 * the SA's mechanics ruling: until then the confirm is refused with nothing written (ON_RUN), which is safe.
 */
type Run = { status?: string | null; driver?: { contactName?: string | null } | null } | null;
export type RunOrder = {
  status: string;
  fulfillPath: string;
  shippedAt?: Date | string | null;
  routeRun?: Run;
  routeRunStop?: { status?: string | null; routeRun?: Run } | null;
};

const ACTIVE_RUN = new Set(["SCHEDULED", "IN_PROGRESS"]);
const STOP_STARTED = new Set(["IN_PROGRESS", "COMPLETED", "SKIPPED"]);

export function completeAtCounterRunRefusal(
  order: RunOrder,
  removeFromRun: boolean,
): ConflictException | null {
  const shipped =
    order.fulfillPath === "SHIP" && (!!order.shippedAt || order.status === "OUT_FOR_DELIVERY");
  if (shipped) {
    return new ConflictException({
      code: API_ERROR_CODES.COUNTER_COMPLETE_SHIPPED,
      message: "This order has shipped with the carrier.",
    });
  }
  const run = order.routeRunStop?.routeRun ?? order.routeRun ?? null;
  const onActiveRun = !!run?.status && ACTIVE_RUN.has(run.status);
  const outOnRoute = order.status === "OUT_FOR_DELIVERY" && order.fulfillPath === "ROUTE";
  if (!onActiveRun && !outOnRoute) return null;
  if (order.routeRunStop?.status && STOP_STARTED.has(order.routeRunStop.status)) {
    return new ConflictException({
      code: API_ERROR_CODES.COUNTER_COMPLETE_STOP_STARTED,
      message: "The driver has already started this stop, so it can't be completed at the counter.",
    });
  }
  const driverName = run?.driver?.contactName ?? null;
  // The confirmed removal waits on the SA's mechanics ruling (`removeFromRun` is accepted but not acted on yet).
  void removeFromRun;
  return new ConflictException({
    code: API_ERROR_CODES.COUNTER_COMPLETE_ON_RUN,
    message: driverName
      ? `This order is on ${driverName}'s run. Completing it here takes it off the run.`
      : "This order is on a delivery run. Completing it here takes it off the run.",
    driverName,
  });
}
