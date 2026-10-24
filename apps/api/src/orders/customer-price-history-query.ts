import { OrderStatus, PriceType } from "@prisma/client";
import { roundMoney } from "@routeflow/pricing";
import type { PrismaService } from "../prisma/prisma.service";

/** A tenant-scoped Prisma client: what `prisma.forTenant()` returns. */
export type PriceHistoryDb = ReturnType<PrismaService["forTenant"]>;

export type CustomerPriceHistory = Record<string, { lastPrice: number; listPriceAtTime: number }>;

/**
 * A customer's remembered per-product price (the "sticky" price): the most recently saved non-promo, non-unit-aware
 * order line that carried an original price. The ONE query behind `OrdersService.getCustomerPriceHistory` (which orders
 * bill from) and the units v2 Customer view (which must show the same price), so the two cannot drift.
 *
 * Tenant scoping comes from the caller's `forTenant()` client. PROMO lines are excluded (a promotion's net price is
 * transient); B606: unit-aware lines (`unitLabel` set) are excluded (a Case price is per-case money).
 */
export async function loadCustomerPriceHistory(
  db: PriceHistoryDb,
  customerId: string,
): Promise<CustomerPriceHistory> {
  const items = await db.orderItem.findMany({
    where: {
      order: {
        customerId,
        status: { notIn: [OrderStatus.CANCELLED] },
      },
      originalPrice: { not: null },
      priceType: { not: PriceType.PROMO },
      unitLabel: null,
    },
    // Order by updatedAt so the MOST RECENTLY SAVED override wins.
    orderBy: { updatedAt: "desc" },
    distinct: ["productId"],
    select: {
      productId: true,
      unitPrice: true,
      originalPrice: true,
    },
  });

  return Object.fromEntries(
    items
      .flatMap((item) => (item.productId ? [item] : []))
      .map((item) => [
        item.productId as string,
        {
          lastPrice: roundMoney(Number(item.unitPrice)),
          listPriceAtTime: roundMoney(Number(item.originalPrice)),
        },
      ]),
  );
}
