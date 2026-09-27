import { ForbiddenException } from "@nestjs/common";

/**
 * SA-429 (#2377) — the DRIVER ownership predicate for `OrdersService.updateOrderItems`.
 *
 * Before this, the DRIVER path (replace and diff) checked no assignment at all: any driver could edit
 * any order's items. The predicate, exactly: `driver` = the tenant's Driver row whose `userId` is the
 * caller (none ⇒ 403); follow the ORDER's own chain `order.routeRunStopId → RouteRunStop → RouteRun`
 * — never `order.routeRunId` on its own, the stop is the assignment; allowed iff
 * `run.driverId === driver.id` AND `run.status === IN_PROGRESS` AND `stop.status ∈ {PENDING,
 * IN_PROGRESS}`. Everything else is the ONE bare 403 below, whatever the branch, so an unassigned
 * driver learns nothing about the order.
 *
 * `db` is always a tenant-scoped client (`prisma.forTenant()` before the transaction, the tx proxy
 * inside it), so no cross-tenant comparison is ever made. The service calls this TWICE with the two
 * clients (SA-389): first, before the order is even loaded, and again under the Order FOR UPDATE, so
 * a run reassigned, completed or cancelled while the edit waited is refused too. One predicate, never
 * two. Staff and CUSTOMER principals return immediately (no read).
 */
const DENY = "You do not have access to this order";
const EDITABLE_STOP = new Set(["PENDING", "IN_PROGRESS"]);

// `any` results, as unit-aware-guard.ts's ParentDb: the Prisma delegates return their full row
// types; only the selected fields are read (a narrower structural type would not accept them).
interface DriverEditDb {
  driver: { findFirst(args: unknown): Promise<any> };
  order: { findFirst(args: unknown): Promise<any> };
  routeRunStop: { findFirst(args: unknown): Promise<any> };
}

export async function assertDriverMayEditOrder(
  db: DriverEditDb,
  orderId: string,
  user: { role?: string; sub?: string } | undefined,
): Promise<void> {
  if (user?.role !== "DRIVER") return;
  const driver = await db.driver.findFirst({ where: { userId: user.sub }, select: { id: true } });
  if (!driver) throw new ForbiddenException(DENY);
  const order = await db.order.findFirst({
    where: { id: orderId },
    select: { routeRunStopId: true },
  });
  if (!order?.routeRunStopId) throw new ForbiddenException(DENY);
  const stop = await db.routeRunStop.findFirst({
    where: { id: order.routeRunStopId },
    select: { status: true, routeRun: { select: { driverId: true, status: true } } },
  });
  const run = stop?.routeRun;
  const allowed =
    !!stop &&
    !!run &&
    run.driverId === driver.id &&
    run.status === "IN_PROGRESS" &&
    EDITABLE_STOP.has(stop.status);
  if (!allowed) throw new ForbiddenException(DENY);
}
