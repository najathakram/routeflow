import { BadRequestException } from "@nestjs/common";
import type { PrismaService } from "../../prisma/prisma.service";
import {
  QUICK_KEYS_MAX_WINDOW_DAYS,
  QUICK_KEYS_RANK_TAKE,
} from "../../system-config/quick-keys-settings";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The quick keys ranking (SA-747): the ids of this tenant's best-selling counter products, best first, ONE query.
 *
 * Rank = the number of DISTINCT counter orders a product appears on (two lines of one product in one order count
 * once), over the look-back window; ties by units sold, then product name, then id (a total order, so the answer
 * is stable). `COUNT(DISTINCT ...)` is not available through Prisma's `groupBy`, so this is one tagged-template
 * `$queryRaw`: EVERY value (tenant, window start, take) is a bound parameter, nothing is concatenated.
 *
 * Tenant safety: the raw client does not add the tenant, so the clause is explicit on BOTH tables
 * (`Order.tenantId` and `Product.tenantId`) and the tenant id is refused when empty BEFORE the query (an empty
 * value would otherwise be a bound NULL, matching nothing, but a caller bug must fail loudly: L-238).
 * A counter order is `Order.counterSale = true` and not CANCELLED; the product must be active; a line with no
 * product (an unlisted ad-hoc line) is not ranked. (`Product` has no `deletedAt`: deactivation is how a product
 * leaves the catalogue, and a hard delete is blocked by the OrderItem FK.)
 *
 * Units: the sum of the stored line `qty`. A counter line is written box-split (`qty` already in pieces) or in
 * the line's own unit; no pack expansion happens here, because a second place that multiplies a boxes-null qty
 * by a pack size is exactly what `no-second-legacy-line-pieces.spec.ts` forbids. Units is a tie-break only.
 */
export async function rankCounterProducts(
  prisma: Pick<PrismaService, "$queryRaw">,
  tenantId: string,
  windowDays: number,
  now: Date = new Date(),
): Promise<string[]> {
  if (!tenantId) throw new BadRequestException("A tenant is required");
  if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > QUICK_KEYS_MAX_WINDOW_DAYS) {
    throw new BadRequestException("The look-back window is out of range");
  }
  const since = new Date(now.getTime() - windowDays * DAY_MS);
  const rows = await prisma.$queryRaw<{ productId: string }[]>`
    SELECT oi."productId" AS "productId"
    FROM "OrderItem" oi
    JOIN "Order" o ON o."id" = oi."orderId"
    JOIN "Product" p ON p."id" = oi."productId"
    WHERE o."tenantId" = ${tenantId}
      AND o."counterSale" = true
      AND o."status" <> 'CANCELLED'
      AND o."createdAt" >= ${since}
      AND oi."productId" IS NOT NULL
      AND p."tenantId" = ${tenantId}
      AND p."isActive" = true
    GROUP BY oi."productId", p."name"
    ORDER BY COUNT(DISTINCT oi."orderId") DESC,
             SUM(oi."qty") DESC,
             p."name" ASC,
             oi."productId" ASC
    LIMIT ${QUICK_KEYS_RANK_TAKE}
  `;
  return rows.map((r) => r.productId);
}
