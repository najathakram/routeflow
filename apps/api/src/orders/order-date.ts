import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
import {
  orderDateDrift,
  orderDateRange,
  tenantDayOf,
  isRealDay,
  type OrderDatePolicy,
} from "@routeflow/pricing";
import { AUDIT_ACTIONS } from "../audit/audit-actions.constant";
import { operatorDeniedGroups } from "../auth/permissions/operator-denied-groups";
import type { PrismaService } from "../prisma/prisma.service";
import { tenantTimeZone } from "../common/tenant-time-zone";
import { staffMay } from "../auth/permissions/staff-capabilities";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { isoFromCalendarDate } from "../common/calendar-date";
import { anyLockedFiling, lockedFilingsCovering, type FilingsDb } from "../regulated/filed-periods";
import { periodBucketOf } from "../regulated/period";

/**
 * W-1188 (SA ruling 2026-11-09): the ONE gate for a sale's business date. Every caller passes a policy and the caller's
 * denied groups (both required, so the compiler finds every call site). A day is judged as a day string on the TENANT's
 * calendar (never an instant, never the UTC day), and an unknown zone reads UTC.
 *
 *  - OFFICE (POST /orders, /orders/sell, a sale-mode invoice): no day after the tenant's today.
 *  - COUNTER (the counter sale only): future days too, up to the cap in `@routeflow/pricing`. On the office order a
 *    future day already means the delivery date, so only the till may date a sale ahead.
 */
export type { OrderDatePolicy };

/** Which policy an order is judged under: the till is COUNTER, everything else OFFICE. Never a profile key or a slug. */
export function orderDatePolicyFor(
  options: { counterSale?: boolean } | undefined,
): OrderDatePolicy {
  return options?.counterSale === true ? "COUNTER" : "OFFICE";
}

export interface ResolveOrderDateInput {
  role: string | null | undefined;
  deniedGroups: readonly string[];
  zone: string | null | undefined;
  policy: OrderDatePolicy;
  now?: Date;
}

/** The staff-supplied business day as the house storage stamp (midnight UTC of the chosen day), or undefined when none was sent. */
export function resolveOrderDate(
  raw: string | undefined | null,
  input: ResolveOrderDateInput,
): Date | undefined {
  if (raw == null) return undefined;
  // POST /orders is reachable by CUSTOMER and DRIVER: only staff who hold SET_ORDER_DATE may date an order.
  if (!staffMay(input.role, "SET_ORDER_DATE", input.deniedGroups)) {
    throw new ForbiddenException("Only staff can set an order date");
  }
  const day = raw.slice(0, 10);
  if (!isRealDay(day)) throw new BadRequestException("Invalid order date");
  const today = tenantDayOf(input.now ?? new Date(), input.zone);
  const { min, max } = orderDateRange(today, input.policy);
  if (day < min || day > max) {
    throw new BadRequestException({
      code: API_ERROR_CODES.ORDER_DATE_OUT_OF_RANGE,
      message:
        day > max ? "That order date is too far ahead." : "That order date is too far in the past.",
      policy: input.policy,
      min,
      max,
    });
  }
  return new Date(isoFromCalendarDate(day));
}

/** The reads `assertOrderDateOpen` makes (a tenant client, or a unit-test stub). */
export type OrderDateDb = FilingsDb & {
  product?: {
    findMany(args: any): Promise<Array<{ id: string; trackedCategoryId: string | null }>>;
  };
  trackedCategory?: { findMany(args: any): Promise<Array<{ id: string; name: string }>> };
};

/**
 * Refuse BEFORE anything is written when the order date falls in a LOCKED regulated period for a category in the cart
 * (409 ORDER_DATE_PERIOD_LOCKED). A cart with no regulated line is never refused: the lock is per category. The
 * ledger writer's own guard stays as the last line (a lock landing between this check and the insert still refuses there).
 * Cheap exit: tenants with no locked filing pay one one-row read.
 */
export async function assertOrderDateOpen(
  db: OrderDateDb,
  input: { tenantId: string; orderDay: Date; productIds: readonly string[] },
): Promise<void> {
  if (!(await anyLockedFiling(db, input.tenantId))) return;
  const ids = [...new Set(input.productIds)];
  if (ids.length === 0 || !db.product) return;
  const products = await db.product.findMany({
    where: { id: { in: ids } },
    select: { id: true, trackedCategoryId: true },
  });
  const bucket = periodBucketOf(input.orderDay);
  const refs = products.map((p) => ({
    trackedCategoryId: p.trackedCategoryId,
    periodBucket: bucket,
  }));
  const hit = (await lockedFilingsCovering(db, refs, input.tenantId))[0];
  if (!hit) return;
  const category = await db.trackedCategory?.findMany({
    where: { id: hit.trackedCategoryId },
    select: { id: true, name: true },
  });
  throw new ConflictException({
    code: API_ERROR_CODES.ORDER_DATE_PERIOD_LOCKED,
    message:
      "That date is in a filed and locked period. Pick a date in an open month, or use today.",
    periodKey: hit.periodBucket,
    categoryName: category?.[0]?.name ?? null,
  });
}

type DatedUser = {
  role: string;
  sub: string;
  tenantId: string | null;
  impersonatedBy?: string | null;
};

/**
 * `OrdersService.create`'s date step: the zone and the caller's denied groups are read ONLY when a date is sent, so an
 * undated order costs nothing. Returns the day to store and the zone the audit row and the drift are judged in.
 */
export async function resolveCreate(
  prisma: PrismaService,
  dto: { orderDate?: string | null },
  user: DatedUser,
  options: { counterSale?: boolean } | undefined,
): Promise<{ orderDate: Date | undefined; orderZone: string | null }> {
  if (dto.orderDate == null) return { orderDate: undefined, orderZone: null };
  const orderZone = await tenantTimeZone(prisma, { tenantId: user.tenantId });
  const orderDate = resolveOrderDate(dto.orderDate, {
    role: user.role,
    deniedGroups: await operatorDeniedGroups(prisma, user as never),
    zone: orderZone,
    policy: orderDatePolicyFor(options),
  });
  return { orderDate, orderZone };
}

/**
 * The pre-write lock check for `create` (after its replay branch, so a retry of a sale that landed still replays):
 * refused HERE, before the stock lock and the transaction, in plain words.
 */
export async function assertCreateOrderDateOpen(
  prisma: PrismaService,
  orderDate: Date | undefined,
  items: ReadonlyArray<{ productId?: string | null }> | undefined,
): Promise<void> {
  const tenantId = prisma.getTenantId();
  if (!orderDate || !tenantId) return;
  await assertOrderDateOpen(prisma.forTenant() as never, {
    tenantId,
    orderDay: orderDate,
    productIds: (items ?? []).flatMap((i) => (i.productId ? [i.productId] : [])),
  });
}

/** ONE `order.dated` audit row per dated order (day differs from its entry day), written inside create()'s transaction. */
export async function recordOrderDated(
  tx: { auditLog: { create(args: any): Promise<unknown> } },
  user: DatedUser,
  created: { id: string; createdAt: Date; orderNumber: unknown; registerKey?: string | null },
  dated: { orderDate: Date | undefined; zone: string | null; options?: { counterSale?: boolean } },
): Promise<void> {
  const drift = orderDateDrift(dated.orderDate, created.createdAt, dated.zone);
  if (!drift) return;
  await tx.auditLog.create({
    data: {
      tenantId: user.tenantId,
      userId: user.sub,
      impersonatedBy: user.impersonatedBy ?? null,
      action: AUDIT_ACTIONS.ORDER_DATED,
      entityType: "Order",
      entityId: created.id,
      meta: {
        orderNumber: created.orderNumber,
        orderDay: drift.day,
        enteredDay: drift.enteredDay,
        direction: drift.direction,
        days: drift.days,
        surface: dated.options?.counterSale ? "counter" : "office",
        registerKey: created.registerKey ?? null,
      },
    },
  });
}

/** The gate `resolveSaleDelivery` needs for `createSale` (denied groups read only when a date is sent). */
export async function saleDateGate(
  prisma: PrismaService,
  dto: { deliveredOn?: string | null; orderDate?: string | null },
  user: DatedUser,
  sale: { counterSale?: boolean } | undefined,
): Promise<{ deniedGroups: readonly string[]; policy: OrderDatePolicy }> {
  return {
    deniedGroups:
      dto.deliveredOn != null || dto.orderDate != null
        ? await operatorDeniedGroups(prisma, user as never)
        : [],
    policy: orderDatePolicyFor(sale),
  };
}
