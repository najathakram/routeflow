import { ConflictException } from "@nestjs/common";
import { OrderStatus } from "@prisma/client";
import { API_ERROR_CODES } from "../common/api-error-codes";
import type { PrismaService } from "../prisma/prisma.service";

/**
 * A literal copy of `ORDER_DELIVERED_ON_ROUTE_STOP_COPY` in packages/types (this app never value-imports that package at
 * runtime); common/order-route-stop-copy-parity.spec.ts pins the two byte-equal.
 */
export const ORDER_DELIVERED_ON_ROUTE_STOP_COPY =
  "This order is on a delivery run. Complete its stop on the route, or take it off the run first.";

/**
 * Row 590 (SA-978a): an office DELIVERED (`changeStatus`, operator / tenant admin) on an order whose run stop has NOT
 * completed is refused, 409 ORDER_DELIVERED_ON_ROUTE_STOP, before any write. A run order's delivery is written by its stop
 * (rows, payments, POD, the run's settlement); stamping it from the office would be a second writer over a stop the driver
 * may still complete, and `stampDeliveredInFull` skips a run-stop order, so the order would read DELIVERED with
 * `deliveredQty` 0 (the B692 state). A COMPLETED stop is not refused: the route delivered it. Fail closed: a link whose stop
 * row cannot be read is refused too. One read of the stop's status, on this transition only; no link, no read.
 */
export async function assertStopDoneForOfficeDelivered(
  prisma: Pick<PrismaService, "forTenant">,
  order: { routeRunStopId?: string | null },
  to: OrderStatus,
): Promise<void> {
  if (to !== OrderStatus.DELIVERED || !order.routeRunStopId) return;
  const stop = await prisma.forTenant().routeRunStop.findUnique({
    where: { id: order.routeRunStopId },
    select: { status: true },
  });
  if (stop?.status === "COMPLETED") return;
  throw new ConflictException({
    code: API_ERROR_CODES.ORDER_DELIVERED_ON_ROUTE_STOP,
    message: ORDER_DELIVERED_ON_ROUTE_STOP_COPY,
  });
}
