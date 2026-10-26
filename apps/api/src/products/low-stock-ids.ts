import { UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { API_ERROR_CODES, LOW_STOCK_DEFAULT } from "@routeflow/types";
import type { PrismaService } from "../prisma/prisma.service";

/**
 * SA-1002 (W-925): the ids of the tenant's LOW-stock products, for the Low and In-stock list filters. Prisma cannot compare a
 * Decimal column to an Int column with a default in a where, so the rule is one tagged `Prisma.sql` here and the list, ids
 * and CSV callers fold the result in as `id in (...)`.
 *
 * The rule is `packages/types/api/stock-level.ts`: `isActive AND stock <= COALESCE(reorderPoint, LOW_STOCK_DEFAULT)`,
 * inclusive; the default is the constant itself, bound as a parameter, never a second literal.
 */

/** Below Postgres's bind-parameter limit with room for the other clauses. Above it the filter fails loudly, never truncates. */
export const LOW_STOCK_ID_CAP = 20_000;

/** The statement, with the tenant and the default bound as parameters. Exported for the spec that pins it to the constant. */
export function lowStockIdsQuery(tenantId: string): Prisma.Sql {
  return Prisma.sql`
    SELECT "id" FROM "Product"
    WHERE "tenantId" = ${tenantId}
      AND "isActive" = true
      AND "currentStock" <= COALESCE("reorderPoint", ${LOW_STOCK_DEFAULT})
    ORDER BY "id"
    LIMIT ${LOW_STOCK_ID_CAP + 1}`;
}

/** The request's tenant (never a client value) scopes the read; RLS is set for it the same way as every tenant transaction. */
export async function lowStockProductIds(prisma: PrismaService): Promise<string[]> {
  const tenantId = prisma.getTenantId();
  if (!tenantId) throw new Error("lowStockProductIds needs a tenant context");
  const rows = await prisma.tenantTransaction(async (tx: any) => {
    return (await tx.$queryRaw(lowStockIdsQuery(tenantId))) as { id: string }[];
  });
  if (rows.length > LOW_STOCK_ID_CAP) {
    throw new UnprocessableEntityException({
      code: API_ERROR_CODES.LOW_STOCK_TOO_MANY,
      message: `More than ${LOW_STOCK_ID_CAP} products match the Low stock filter. Narrow it with a search or a category.`,
    });
  }
  return rows.map((r) => r.id);
}
