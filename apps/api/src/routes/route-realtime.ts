import { OrderStatus, RouteRunStatus, RouteRunStopStatus } from "@prisma/client";
import type { PrismaService } from "../prisma/prisma.service";
import type { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { NON_ROUTABLE_ORDER_STATUSES } from "./routes.constants";

type RealtimeGateway = Pick<
  RouteFlowGateway,
  "emitOrderStatusChanged" | "emitStopCompleted" | "emitRouteProgress" | "emitDriverStatusUpdated"
>;

/** An order as the route methods already hold it (their pre-transaction snapshot). */
export interface RouteOrderRef {
  id: string;
  orderNumber: string | null;
  customerId: string;
  status: OrderStatus;
}

/**
 * #2095: every realtime announcement a run/stop mutation makes, called only AFTER the caller's
 * write committed. Nothing here throws: the write is done, so a failed read or emit is one warn
 * line, never a failed request (a 500 after commit sends the driver app into a retry that then
 * reads "Stop is already completed"). Each step is guarded on its own, so one failure never
 * suppresses the others. Warn lines carry ids only.
 *
 * Who receives what (the privacy rule: a buyer only ever sees its OWN order/stop):
 *  - `order.statusChanged` — operators + the order's own customer room (gateway rule).
 *  - `route.stop.completed` — operators only.
 *  - `route.progress` — `{ runId }` only, to the customers of the run's stops not yet COMPLETED.
 */
export class RouteRealtime {
  constructor(
    private readonly prisma: Pick<PrismaService, "forTenant" | "getTenantId">,
    private readonly gateway: RealtimeGateway,
    private readonly logger: { warn(message: string): void },
  ) {}

  /**
   * `route.progress` to every customer whose tracking card a change on this run can move: the
   * customers of the run's stops that are not COMPLETED, read after the commit (a stop's own
   * customerId plus its linked orders' customers — after a release the order link is gone but
   * the stop still names its customer). A completed stop's customer hears of its own delivery
   * through `order.statusChanged`.
   */
  async runProgress(runId: string): Promise<void> {
    try {
      const stops: Array<{ customerId: string | null; orders?: Array<{ customerId: string }> }> =
        await this.prisma.forTenant().routeRunStop.findMany({
          where: { routeRunId: runId, status: { not: RouteRunStopStatus.COMPLETED } },
          select: { customerId: true, orders: { select: { customerId: true } } },
        });
      const customerIds = new Set<string>();
      for (const stop of stops ?? []) {
        if (stop.customerId) customerIds.add(stop.customerId);
        for (const order of stop.orders ?? []) {
          if (order.customerId) customerIds.add(order.customerId);
        }
      }
      if (customerIds.size === 0) return;
      this.gateway.emitRouteProgress(this.prisma.getTenantId(), [...customerIds], { runId });
    } catch (err) {
      this.warn("route.progress", runId, err);
    }
  }

  /**
   * A stop completed. DELIVERED per order this completion flipped — the orders whose
   * pre-transaction status was routable, the same snapshot and filter the P6-5 DELIVERED
   * notification beside the call uses (a nudge to refetch, not the source of truth); then the
   * operators' `route.stop.completed`; then the auto-completed run's driver status; then
   * `route.progress` to the stops still open.
   */
  async stopCompleted(
    runId: string,
    stop: { id: string; customerId: string | null; orders: RouteOrderRef[] },
    autoCompleted: boolean,
  ): Promise<void> {
    const orders = stop.orders;
    const flipped = orders.filter((o) => !NON_ROUTABLE_ORDER_STATUSES.includes(o.status));
    this.announceStatuses(runId, flipped, OrderStatus.DELIVERED);

    try {
      this.gateway.emitStopCompleted(this.prisma.getTenantId(), {
        runId,
        stopId: stop.id,
        customerId: stop.customerId,
        orderId: orders.length === 1 ? orders[0].id : undefined,
        completedAt: new Date().toISOString(),
      });
    } catch (err) {
      this.warn("route.stop.completed", runId, err);
    }

    if (autoCompleted) {
      try {
        const completed = await this.prisma.forTenant().routeRun.findUnique({
          where: { id: runId },
          include: {
            driver: {
              select: { id: true, contactName: true, user: { select: { username: true } } },
            },
          },
        });
        if (completed?.driver) {
          this.gateway.emitDriverStatusUpdated(this.prisma.getTenantId(), {
            driverId: completed.driver.id,
            driverName: completed.driver.contactName ?? completed.driver.user?.username ?? "Driver",
            status: RouteRunStatus.COMPLETED,
            updatedAt: new Date().toISOString(),
          });
        }
      } catch (err) {
        this.warn("driver.status.updated", runId, err);
      }
    }

    await this.runProgress(runId);
  }

  /** A stop reopened: CONFIRMED per order the reopen flipped, then `route.progress`. */
  async stopReopened(runId: string, reopened: RouteOrderRef[]): Promise<void> {
    this.announceStatuses(runId, reopened, OrderStatus.CONFIRMED);
    await this.runProgress(runId);
  }

  private announceStatuses(runId: string, orders: RouteOrderRef[], status: OrderStatus): void {
    for (const o of orders) {
      try {
        this.gateway.emitOrderStatusChanged(this.prisma.getTenantId(), {
          orderId: o.id,
          orderNumber: o.orderNumber ?? "",
          customerId: o.customerId,
          status,
          previousStatus: o.status,
        });
      } catch (err) {
        this.warn(`order.statusChanged (order ${o.id})`, runId, err);
      }
    }
  }

  private warn(event: string, runId: string, err: unknown): void {
    this.logger.warn(
      `[#2095] ${event} for run ${runId} not sent: ${(err as Error)?.message ?? String(err)}`,
    );
  }
}
