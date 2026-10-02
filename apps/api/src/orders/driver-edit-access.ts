import { ConflictException, ForbiddenException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";

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

/** A PrismaService-shaped client; `tenantTransaction`'s own generics don't survive a structural type. */
type TenantTx = { tenantTransaction(fn: (tx: any) => Promise<any>, ...rest: any[]): Promise<any> };

/**
 * SA-434 (#2391): run `write` under the Order FOR UPDATE with the SA-429 predicate re-derived on the
 * tx client first, so a run reassigned, completed or cancelled while this waited on the lock is the
 * same bare 403 with nothing written. For staff/CUSTOMER the predicate is a no-op and this is just
 * the locked transaction. One predicate, one file (SA-070).
 */
export function underOrderLockForDriver(
  prisma: TenantTx,
  orderId: string,
  user: { role?: string; sub?: string } | undefined,
  write: (tx: any) => Promise<any>,
): Promise<any> {
  return prisma.tenantTransaction(async (tx: any) => {
    await tx.$executeRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
    await assertDriverMayEditOrder(tx, orderId, user);
    return write(tx);
  });
}

/**
 * SA-434: the DRIVER's one status write — PENDING → CONFIRMED — as a compare-and-set under the lock.
 * `count 0` means the order left PENDING while this waited: 409 ORDER_CHANGED_DURING_EDIT.
 */
export function confirmPendingAsDriver(
  prisma: TenantTx,
  orderId: string,
  user: { role?: string; sub?: string } | undefined,
  data: Record<string, unknown>,
) {
  return underOrderLockForDriver(prisma, orderId, user, async (tx) => {
    const { count } = await tx.order.updateMany({
      where: { id: orderId, status: "PENDING" },
      data,
    });
    if (count === 0)
      throw new ConflictException({
        code: API_ERROR_CODES.ORDER_CHANGED_DURING_EDIT,
        message: "The order changed while your update was being applied — review it and try again.",
      });
    return tx.order.findUnique({ where: { id: orderId } });
  });
}
