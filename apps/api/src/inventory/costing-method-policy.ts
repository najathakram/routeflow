import { BadRequestException } from "@nestjs/common";
import { CostingMethod } from "@prisma/client";
import { API_ERROR_CODES } from "../common/api-error-codes";

/**
 * SA-804 (1) / B1232 + B1233: FIFO and LIFO are RETIRED costing methods.
 *
 * - No enum migration: both stay in the Prisma enum and old rows keep their value.
 * - WRITE side: nothing may SET them. Every writer of `Product.costingMethod` or the tenant
 *   `costing.method` goes through `assertCostingMethodAllowed` (400 COSTING_METHOD_RETIRED) or, when it
 *   only COPIES an existing product's method (a variant inheriting its parent), through
 *   `effectiveCostingMethod`. `common/costing-method-retired.spec.ts` census-scans apps/api/src and
 *   fails a writer that does neither.
 * - READ side: a stored FIFO/LIFO is costed as AVCO (`effectiveCostingMethod`): `sale-movement.ts` no
 *   longer consumes lots for them.
 *
 * Literal mirror of `RETIRED_COSTING_METHODS` in `packages/types/api/enums.ts` (the API never
 * value-imports `@routeflow/types`); the pin spec holds the two equal.
 */
export const RETIRED_COSTING_METHODS = ["FIFO", "LIFO"] as const;

export function isRetiredCostingMethod(method: string | null | undefined): boolean {
  return method != null && (RETIRED_COSTING_METHODS as readonly string[]).includes(method);
}

/**
 * Refuse a request that would SET a retired method. A write that leaves an ALREADY-stored value
 * unchanged is not a set: pass `stored` (the row's current value) and an identical value passes, so a
 * client that echoes the whole product back never fails on an old FIFO/LIFO row.
 */
export function assertCostingMethodAllowed(
  method: string | null | undefined,
  stored?: string | null,
): void {
  if (!isRetiredCostingMethod(method)) return;
  if (stored != null && stored === method) return;
  throw new BadRequestException({
    code: API_ERROR_CODES.COSTING_METHOD_RETIRED,
    message:
      "FIFO and LIFO costing are retired. Use average cost (AVCO), standard cost or last cost.",
  });
}

/** The method a row is COSTED by: a stored FIFO/LIFO is average cost. Anything else is itself. */
export function effectiveCostingMethod(method: CostingMethod): CostingMethod;
export function effectiveCostingMethod(
  method: CostingMethod | null | undefined,
): CostingMethod | undefined;
export function effectiveCostingMethod(
  method: CostingMethod | null | undefined,
): CostingMethod | undefined {
  if (method == null) return undefined;
  return isRetiredCostingMethod(method) ? CostingMethod.AVCO : method;
}
