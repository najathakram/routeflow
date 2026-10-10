import { getTierPrice, roundMoney } from "@routeflow/pricing";
import type { PrismaService } from "../../prisma/prisma.service";

type TenantDb = ReturnType<PrismaService["forTenant"]>;

/**
 * POS-5 audit: the TIER price each product starts from for this customer (productId -> cents-rounded price) —
 * the SAME server-resolved baseline `create()` judges a price change against (the customer's per-product tier
 * override, else their default tier, read off the product's tier columns). Read-only. Never throws: on any
 * failure the map is empty, so the audit row is still written (with a null tier price) rather than lost.
 */
export async function resolveTierPrices(
  db: TenantDb,
  customerId: string,
  productIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (productIds.length === 0) return out;
  try {
    const [customer, overrides, products] = await Promise.all([
      db.customer.findFirst({ where: { id: customerId }, select: { pricingTier: true } }),
      db.customerPrice.findMany({ where: { customerId, productId: { in: productIds } } }),
      db.product.findMany({
        where: { id: { in: productIds } },
        select: {
          id: true,
          pricePerUnit: true,
          priceTier2: true,
          priceTier3: true,
          priceTier4: true,
          priceTier5: true,
        },
      }),
    ]);
    const defaultTier = customer?.pricingTier ?? 1;
    const tierOf = new Map(overrides.map((o) => [o.productId, o.pricingTier]));
    for (const p of products) {
      out.set(p.id, roundMoney(getTierPrice(p, tierOf.get(p.id) ?? defaultTier)));
    }
  } catch {
    out.clear();
  }
  return out;
}
