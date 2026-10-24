import { getTierPrice, roundMoney } from "@routeflow/pricing";
import type { PrismaService } from "../../prisma/prisma.service";
import { customerPricing } from "../units-prices-v2";

type TenantDb = ReturnType<PrismaService["forTenant"]>;

/**
 * POS-5 audit: the TIER price each product starts from for this customer (productId -> cents-rounded price) —
 * the SAME server-resolved baseline `create()` judges a price change against (the customer's per-product tier
 * override, else their default tier, read off the product's tier columns). Read-only. Never throws: on any
 * failure the map is empty, so the audit row is still written (with a null tier price) rather than lost.
 *
 * S19b A-4: with `flag.units_prices_v2` on (the caller passes `svc`) the baseline is the customer layer's price when the pack
 * is in it, exactly what create() judges and bills; without `svc`, or flag off, it is master's tier price.
 */
export async function resolveTierPrices(
  db: TenantDb,
  customerId: string,
  productIds: string[],
  svc?: Pick<Parameters<typeof customerPricing>[0], "entitlements"> & {
    prisma: { getTenantId?(): string | null | undefined };
  },
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
          unit: true,
          packLabel: true,
          baseUnitLabel: true,
          unitsPerBox: true,
          orderUnitRef: true,
          packAuto: true,
          pricePerUnit: true,
          priceTier2: true,
          priceTier3: true,
          priceTier4: true,
          priceTier5: true,
        },
      }),
    ]);
    const pc = await customerPricing(
      {
        prisma: { forTenant: () => db, getTenantId: () => svc?.prisma.getTenantId?.() },
        entitlements: svc?.entitlements,
      },
      customerId,
      productIds,
      customer,
      overrides,
      db as never,
    );
    for (const p of products) {
      out.set(
        p.id,
        roundMoney(pc.layer(p)?.price ?? getTierPrice(p, pc.cpMap.get(p.id) ?? pc.defaultTier)),
      );
    }
  } catch {
    out.clear();
  }
  return out;
}
