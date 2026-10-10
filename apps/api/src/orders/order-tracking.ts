import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { RouteRunStatus, RouteRunStopStatus, UserRole } from "@prisma/client";
// Type-only: @routeflow/types has no build step, so a runtime import would reach Node as TS.
import type { OrderTrackingResponse } from "@routeflow/types";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import type { PrismaService } from "../prisma/prisma.service";

/**
 * Stops the driver has not finished: each one still stands between the driver and every later
 * stop. An IN_PROGRESS stop is one the driver has arrived at and is still working, so it counts.
 */
const UNFINISHED_STOP_STATUSES: ReadonlySet<RouteRunStopStatus> = new Set([
  RouteRunStopStatus.PENDING,
  RouteRunStopStatus.IN_PROGRESS,
]);

/** The driver identity a customer may see (#2095): the first word of the contact name. */
export function driverFirstName(contactName: string | null | undefined): string | null {
  const first = (contactName ?? "").trim().split(/\s+/)[0];
  return first ? first : null;
}

export async function getOrderTracking(
  deps: { prisma: PrismaService },
  orderId: string,
  user: JwtPayload,
): Promise<OrderTrackingResponse> {
  const order = await deps.prisma.forTenant().order.findUnique({
    where: { id: orderId },
    include: {
      customer: { select: { deliveryWindowStart: true, deliveryWindowEnd: true } },
      routeRunStop: {
        include: {
          routeRun: {
            include: {
              driver: { select: { id: true, contactName: true } },
              route: { select: { id: true, name: true } },
              // Only what the count needs (#2095): another customer's stop is never read into
              // this handler, so it can never be returned.
              stops: { select: { stopNumber: true, status: true } },
            },
          },
        },
      },
    },
  });
  if (!order) throw new NotFoundException("Order not found");

  // #2095: a customer-facing caller. The buyer portal's pseudo-user (makePseudoUser) is CUSTOMER
  // role and BUYER type; keying on either means a buyer route that overrides the role can never
  // skip the ownership gate below or see the staff-only fields.
  const customerFacing = user.role === UserRole.CUSTOMER || user.type === "BUYER";

  // Ownership gate (security F2-002): this route has no RolesGuard, so without
  // this any authenticated CUSTOMER could enumerate order ids and read another
  // customer's route/driver/stop/delivery-window. Mirror findOne's CUSTOMER gate.
  if (customerFacing) {
    // REG-B131: `deletedAt: null` here — a removal deactivates the user but an access token
    // minted just before it stays valid for up to 15 minutes, so a removed customer's own
    // in-flight session must fall into the existing refusal below.
    const customer = await deps.prisma
      .forTenant()
      .customer.findFirst({ where: { userId: user.sub, deletedAt: null } });
    if (!customer || customer.id !== order.customerId) throw new ForbiddenException();
  }

  if (!order.routeRunStop) {
    return { status: order.status, tracking: null };
  }

  // F11 (B129 / B146 contract, spec R5): a CANCELLED run is not tracking —
  // the buyer card must never show a driver, a stop number or "you're next"
  // for a called-off run. After F11 the release nulls the pointer at cancel
  // time, so this branch serves rows stranded BEFORE the deploy until the D4
  // repair frees them, and stays as the written contract. A SKIPPED own-stop
  // on a live or completed run keeps the FULL payload (stopStatus: "SKIPPED",
  // stopsAhead exactly as computed below) — the client branches on
  // stopStatus; the server invents no "skipped shape".
  if (order.routeRunStop.routeRun.status === RouteRunStatus.CANCELLED) {
    return { status: order.status, tracking: null };
  }

  const stop = order.routeRunStop;
  const run = stop.routeRun;
  const allStops = run.stops ?? [];
  const currentStopNumber = stop.stopNumber;

  // Stops still to be worked before this customer's stop (#2095: "N stops before you").
  const stopsAhead = allStops.filter(
    (s) => s.stopNumber < currentStopNumber && UNFINISHED_STOP_STATUSES.has(s.status),
  ).length;

  const driverName = run.driver?.contactName ?? null;

  return {
    status: order.status,
    tracking: {
      runId: run.id,
      // #2095 privacy: the route label is the seller's free text (it could name other
      // customers) and a customer only ever sees the driver's first name.
      routeName: customerFacing ? null : (run.route?.name ?? null),
      driverName: customerFacing ? driverFirstName(driverName) : driverName,
      runStatus: run.status,
      stopNumber: currentStopNumber,
      stopStatus: stop.status,
      stopsAhead,
      scheduledDate: run.scheduledDate.toISOString(),
      estimatedArrivalWindow: {
        start: order.customer?.deliveryWindowStart ?? null,
        end: order.customer?.deliveryWindowEnd ?? null,
      },
    },
  };
}
