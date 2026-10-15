import type { Prisma } from "@prisma/client";
import type { ListMovementsDto } from "./dto/list-movements.dto";

/**
 * The ONE `StockMovement` where-clause of a movements query: the list and the CSV export both build it
 * here, so the same filters can never return different rows (CSV-3).
 *
 * B562: the date filter is on `effectiveAt` (the accounting date a backdated movement carries);
 * `createdAt` is write-once insertion time. `to` is inclusive of its whole UTC day.
 */
export function buildMovementsWhere(
  query: Pick<ListMovementsDto, "productId" | "type" | "from" | "to">,
): Prisma.StockMovementWhereInput {
  const where: Prisma.StockMovementWhereInput = {};
  if (query.productId) where.productId = query.productId;
  if (query.type) where.type = query.type;
  if (query.from || query.to) {
    where.effectiveAt = {};
    if (query.from) where.effectiveAt.gte = new Date(query.from);
    if (query.to) {
      const toDate = new Date(query.to);
      toDate.setUTCHours(23, 59, 59, 999);
      where.effectiveAt.lte = toDate;
    }
  }
  return where;
}
