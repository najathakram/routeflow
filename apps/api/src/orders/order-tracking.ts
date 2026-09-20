import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { RouteRunStatus, UserRole } from "@prisma/client";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import type { PrismaService } from "../prisma/prisma.service";

export async function getOrderTracking(
  deps: { prisma: PrismaService },
  orderId: string,
  user: JwtPayload,
) {
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
              stops: { orderBy: { stopNumber: "asc" } },
            },
          },
        },
      },
    },
  });
  if (!order) throw new NotFoundException("Order not found");

  // Ownership gate (security F2-002): this route has no RolesGuard, so without
  // this any authenticated CUSTOMER could enumerate order ids and read another
  // customer's route/driver/stop/delivery-window. Mirror findOne's CUSTOMER gate.
  if (user.role === UserRole.CUSTOMER) {
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

  // Count PENDING stops before this customer's stop
  const stopsAhead = allStops.filter(
    (s) => s.stopNumber < currentStopNumber && s.status === "PENDING",
  ).length;

  return {
    status: order.status,
    tracking: {
      runId: run.id,
      routeName: run.route?.name ?? null,
      driverName: run.driver?.contactName ?? null,
      runStatus: run.status,
      stopNumber: currentStopNumber,
      stopStatus: stop.status,
      stopsAhead,
      estimatedArrivalWindow: {
        start: order.customer?.deliveryWindowStart ?? null,
        end: order.customer?.deliveryWindowEnd ?? null,
      },
    },
  };
}
