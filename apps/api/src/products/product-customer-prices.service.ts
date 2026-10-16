import { Injectable } from "@nestjs/common";
import { canonicalUnitRef, customerTierFor, roundMoney } from "@routeflow/pricing";
import type { PriceTierNumber, ProductCustomerPricesResponse } from "@routeflow/types";
import { PrismaService } from "../prisma/prisma.service";
import { ProductPriceGridService } from "./product-price-grid.service";

/** The most customers one answer holds; one more is read to know whether there are others. */
export const CUSTOMER_PRICES_CAP = 500;

/**
 * The read model behind GET products/:productId/customer-prices (units v2, flag.units_prices_v2): the customers with
 * at least one typed CustomerUnitPrice row on this product, in the shape the planners take (pricing
 * CustomerPricingWithId plus a display name), newest customers first.
 *
 * It adds no price rule: `tier` is `customerTierFor(customer-product tier, customer tier)` (the same call as the K6
 * customer view), `set` the typed prices by unit ref (rounded to cents), `orderUnit` the customer's own order unit for
 * this product. Stored refs are read as levels (SA-809), like the grid. Everything goes through the tenant client, and
 * the product is read first by the grid's own read model, so a product outside the caller's tenant is a 404 and
 * `revision` is exactly the one price-grid answers.
 *
 * One customer read, no per-customer queries: the relation filter picks the customers, and each one carries only this
 * product's typed rows and its customer-product row. Soft-deleted customers are left out (a save refuses them).
 */
@Injectable()
export class ProductCustomerPricesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly grid: ProductPriceGridService,
  ) {}

  async get(productId: string): Promise<ProductCustomerPricesResponse> {
    const db = this.prisma.forTenant();
    const model = await this.grid.read(db, productId);
    const level = (ref: string) => canonicalUnitRef(model.units, ref);

    const rows: {
      id: string;
      businessName: string;
      displayName: string | null;
      pricingTier: number;
      prices: { pricingTier: number | null; orderUnitRef: string | null }[];
      unitPrices: { unitRef: string; price: unknown }[];
    }[] = await db.customer.findMany({
      where: { deletedAt: null, unitPrices: { some: { productId } } },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: CUSTOMER_PRICES_CAP + 1,
      select: {
        id: true,
        businessName: true,
        displayName: true,
        pricingTier: true,
        prices: {
          where: { productId },
          select: { pricingTier: true, orderUnitRef: true },
          take: 1,
        },
        unitPrices: { where: { productId }, select: { unitRef: true, price: true } },
      },
    });

    return {
      productId,
      revision: model.revision,
      customers: rows.slice(0, CUSTOMER_PRICES_CAP).map((c) => {
        const own = c.prices[0];
        // A cell stored before SA-809 may carry the factor-1 row's id: it is the level's "base" cell (an exact one wins).
        const set: Record<string, number> = {};
        const exact = new Set<string>();
        for (const r of c.unitPrices) {
          const ref = level(r.unitRef);
          if (ref in set && !(r.unitRef === ref && !exact.has(ref))) continue;
          set[ref] = roundMoney(Number(r.price));
          if (r.unitRef === ref) exact.add(ref);
        }
        return {
          customerId: c.id,
          name: c.displayName?.trim() || c.businessName,
          tier: customerTierFor(own?.pricingTier, c.pricingTier) as PriceTierNumber,
          orderUnit: own?.orderUnitRef ? level(own.orderUnitRef) : null,
          set,
        };
      }),
      truncated: rows.length > CUSTOMER_PRICES_CAP,
    };
  }
}
