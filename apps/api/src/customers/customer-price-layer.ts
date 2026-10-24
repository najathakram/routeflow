import { NotFoundException } from "@nestjs/common";
import { baseLabelOf, packFactorOf, type LadderProduct } from "@routeflow/pricing";
import type { CustomerPriceLayerResponse, CustomerPriceLayerUnitDto } from "@routeflow/types";
import { customerPricing, type LayerProduct } from "../orders/units-prices-v2";

/** The most typed rows one request reads (like K6's TYPED_ROWS_CAP). Past it the response says `complete: false` (SA-813 M1). */
export const PRICE_LAYER_TYPED_ROWS_CAP = 5000;

type Svc = Parameters<typeof customerPricing>[0];

/**
 * S19b A1 (SA-811a, SA-813): what one customer's price layer is, product by product, for the order, invoice and estimate
 * screens. It adds NO rule: every row is `customerPricing().layer(product, label)` - the very function billing prices a line
 * with (`customerLayerPrice` over `resolveCustomerUnitPrice`) - for the pack and each sellable unit of every product the
 * customer has a typed row for. A unit not in the layer (a typed price on another unit only) has no row, and the client then
 * runs its master chain. The tenant comes from `forTenant()`; a customer outside it is a 404 before any price row is read.
 */
export async function buildCustomerPriceLayer(
  svc: Svc,
  customerId: string,
): Promise<CustomerPriceLayerResponse> {
  const db = svc.prisma.forTenant();
  const tenantId = svc.prisma.getTenantId?.();
  const customer = await db.customer.findFirst({
    where: { id: customerId, tenantId },
    select: { id: true, pricingTier: true },
  });
  if (!customer) throw new NotFoundException("Customer not found");

  // One extra row tells us whether the cap cut the read (M1).
  const typed: Array<{ productId: string }> = await db.customerUnitPrice.findMany({
    where: { customerId, tenantId },
    select: { productId: true },
    take: PRICE_LAYER_TYPED_ROWS_CAP + 1,
  });
  const complete = typed.length <= PRICE_LAYER_TYPED_ROWS_CAP;
  const ids = [...new Set(typed.slice(0, PRICE_LAYER_TYPED_ROWS_CAP).map((r) => r.productId))];
  const empty = { customerId: customer.id, complete, products: {} };
  if (ids.length === 0) return empty;

  const [cpRows, products, units] = await Promise.all([
    db.customerPrice.findMany({ where: { customerId, tenantId, productId: { in: ids } } }),
    db.product.findMany({ where: { id: { in: ids }, tenantId } }),
    db.productUnit.findMany({
      where: { productId: { in: ids }, tenantId },
      orderBy: [{ sortOrder: "asc" }, { factorToBase: "asc" }],
    }),
  ]);
  const pc = await customerPricing(svc, customerId, ids, customer, cpRows, db);
  if (!pc.layered) return empty; // flag off (the route is gated, so only a race) or no usable typed price

  const out: Record<string, CustomerPriceLayerUnitDto[]> = {};
  for (const p of products as Array<LayerProduct & LadderProduct>) {
    const labels: Array<string | null> = [null];
    const own = (units as Array<{ productId: string; label: string; factorToBase: number }>).filter(
      (u) => u.productId === p.id && Number.isInteger(u.factorToBase) && u.factorToBase >= 1,
    );
    for (const u of own) labels.push(u.label);
    // The base level has no row of its own on a boxed pack: it is still sold (derived), so ask for it by its name.
    if (!own.some((u) => u.factorToBase === 1) && packFactorOf(p) > 1) labels.push(baseLabelOf(p));

    const rows: CustomerPriceLayerUnitDto[] = [];
    for (const label of labels) {
      const r = pc.layer(p, label);
      if (!r || rows.some((x) => x.ref === r.unit)) continue;
      rows.push({
        ref: r.unit,
        label,
        price: r.price,
        listPrice: r.listPrice,
        source: r.source,
        aboveList: r.aboveList,
      });
    }
    if (rows.length > 0) out[p.id] = rows;
  }
  return { customerId: customer.id, complete, products: out };
}
