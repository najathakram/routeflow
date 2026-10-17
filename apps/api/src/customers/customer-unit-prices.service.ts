import { Injectable, NotFoundException, Optional } from "@nestjs/common";
import {
  buildLadderView,
  customerAnchor,
  customerTierFor,
  priceGrid,
  roundMoney,
  resolveCustomerUnitPrice,
  unitCodeOf,
  type ProductCodes,
} from "@routeflow/pricing";
import type {
  CustomerProductUnitPricesDto,
  CustomerUnitPricesResponse,
  PriceTierNumber,
} from "@routeflow/types";
import { PrismaService } from "../prisma/prisma.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { buildCustomerPriceLayer } from "./customer-price-layer";
import { clampLimit } from "../common/pagination";
import { loadCustomerPriceHistory } from "../orders/customer-price-history-query";
import { ladderOptionsOf, loadTierOrderUnits } from "../orders/units-prices-v2";
import { CUSTOMER_UNIT_PRICES_MAX_LIMIT } from "./dto/customer-unit-prices-query.dto";

const DEFAULT_LIMIT = 25;
/** Upper bounds on one customer's typed rows read per request (a customer with more is cut, never unbounded). */
const TYPED_ROWS_CAP = 5000;
const CUSTOMER_PRODUCT_ROWS_CAP = 2000;

const PRODUCT_SELECT = {
  id: true,
  name: true,
  unit: true,
  baseUnitLabel: true,
  packLabel: true,
  unitsPerBox: true,
  pricePerUnit: true,
  priceTier2: true,
  priceTier3: true,
  priceTier4: true,
  priceTier5: true,
  sku: true,
  barcode: true,
  unitSku: true,
  priceRevision: true,
  isActive: true,
  orderUnitRef: true,
  packAuto: true,
} as const;

const UNIT_SELECT = {
  id: true,
  productId: true,
  label: true,
  factorToBase: true,
  price: true,
  priceTier2: true,
  priceTier3: true,
  priceTier4: true,
  priceTier5: true,
  isDefaultSelling: true,
  sortOrder: true,
  parentUnitId: true,
  perParent: true,
  sku: true,
} as const;

/**
 * Units v2 Customer view (K6). Read-only; adds no price rule of its own: each row is
 * `resolveCustomerUnitPrice` from @routeflow/pricing, the list and tier prices are cells of the same `priceGrid` the
 * product page shows, and the tier is `customerTierFor(customer-product tier, customer tier)`.
 *
 * Which products: with `productId`, that one. Without it, the ACTIVE products this customer has something specific for: a
 * typed CustomerUnitPrice row, or a CustomerPrice row with its own tier or order unit (an MSRP-only row is not a price
 * here). Everything is read through `forTenant()` and the customer is looked up first, so an id outside the caller's
 * tenant is a 404 before any price row is read.
 *
 * Parity with billing: orders bill a customer's remembered ABOVE-LIST pack price (the sticky upsell, from
 * `loadCustomerPriceHistory`, the same query behind OrdersService.getCustomerPriceHistory) ahead of the tier price, so the
 * pack row shows it with source "history" - but only when the pack is NOT in the customer layer (SA-811a R1: a typed price,
 * or one worked out from their typed price on their order unit, beats the sticky price). Active promotions are not included in these prices. A price typed for the
 * customer (CustomerUnitPrice) still shows as theirs.
 */
@Injectable()
export class CustomerUnitPricesService {
  constructor(
    private readonly prisma: PrismaService,
    // S19b: the customer layer (flag.units_prices_v2) behind /price-layer; billing's own entitlement read.
    @Optional() private readonly entitlements?: EntitlementsService,
  ) {}

  /** S19b A1: `GET /customers/:id/price-layer`, billing's own resolved layer rows (see customer-price-layer.ts). */
  priceLayer(customerId: string) {
    return buildCustomerPriceLayer(
      { prisma: this.prisma, entitlements: this.entitlements },
      customerId,
    );
  }

  async get(
    customerId: string,
    query: { productId?: string; page?: number; limit?: number } = {},
  ): Promise<CustomerUnitPricesResponse> {
    const db = this.prisma.forTenant();
    const customer = await db.customer.findFirst({
      where: { id: customerId },
      select: { id: true, businessName: true, pricingTier: true },
    });
    if (!customer) throw new NotFoundException("Customer not found");

    const limit = clampLimit(query.limit, DEFAULT_LIMIT, CUSTOMER_UNIT_PRICES_MAX_LIMIT);
    const page = Math.max(1, Math.floor(query.page ?? 1));
    const narrow = query.productId ? { productId: query.productId } : {};

    const [typedRows, cpRows] = await Promise.all([
      db.customerUnitPrice.findMany({
        where: { customerId, ...narrow },
        select: { productId: true, unitRef: true, price: true },
        take: TYPED_ROWS_CAP,
      }),
      db.customerPrice.findMany({
        where: {
          customerId,
          ...narrow,
          OR: [{ pricingTier: { not: null } }, { orderUnitRef: { not: null } }],
        },
        select: { productId: true, pricingTier: true, orderUnitRef: true },
        take: CUSTOMER_PRODUCT_ROWS_CAP,
      }),
    ]);

    const candidateIds = query.productId
      ? [query.productId]
      : [...new Set([...typedRows.map((r) => r.productId), ...cpRows.map((r) => r.productId)])];

    // A named product is shown whatever its state; the unnamed list only counts and shows active products.
    const productWhere = query.productId
      ? { id: query.productId }
      : { id: { in: candidateIds }, isActive: true };
    const total = query.productId
      ? candidateIds.length
      : candidateIds.length
        ? await db.product.count({ where: productWhere })
        : 0;
    const products = candidateIds.length
      ? await db.product.findMany({
          where: productWhere,
          select: PRODUCT_SELECT,
          orderBy: [{ name: "asc" }, { id: "asc" }],
          skip: (page - 1) * limit,
          take: limit,
        })
      : [];
    if (query.productId && products.length === 0) throw new NotFoundException("Product not found");

    const ids = products.map((p) => p.id);
    const units = ids.length
      ? await db.productUnit.findMany({
          where: { productId: { in: ids } },
          select: UNIT_SELECT,
          orderBy: [{ sortOrder: "asc" }, { factorToBase: "asc" }],
        })
      : [];

    const history = products.length ? await loadCustomerPriceHistory(db, customerId) : {};
    // S19b A-5: the view carries the product's own anchor options, exactly as billing's loader builds it.
    const tierUnitsBy = await loadTierOrderUnits(db, this.prisma.getTenantId?.(), ids);

    const out: CustomerProductUnitPricesDto[] = products.map((p) => {
      const productUnits = units.filter((u) => u.productId === p.id);
      const cp = cpRows.find((r) => r.productId === p.id);
      const tier = customerTierFor(cp?.pricingTier, customer.pricingTier) as PriceTierNumber;
      const unitPrices = Object.fromEntries(
        typedRows.filter((r) => r.productId === p.id).map((r) => [r.unitRef, Number(r.price)]),
      );
      const product = {
        ...p,
        pricePerUnit: p.pricePerUnit.toString(),
        priceTier2: p.priceTier2.toString(),
        priceTier3: p.priceTier3.toString(),
        priceTier4: p.priceTier4.toString(),
        priceTier5: p.priceTier5.toString(),
      };
      const viewOptions = ladderOptionsOf(p, tierUnitsBy.get(p.id));
      const view = buildLadderView(product, productUnits, viewOptions);
      const grid = priceGrid(view);
      const codes: ProductCodes = {
        sku: p.sku,
        barcode: p.barcode,
        unitSku: p.unitSku,
        unitCodes: Object.fromEntries(productUnits.map((u) => [u.id, u.sku])),
      };
      const orderUnit = cp?.orderUnitRef ?? null;
      const effective = customerAnchor(view, { tier, orderUnit, set: unitPrices });
      return {
        productId: p.id,
        productName: p.name,
        orderUnit,
        orderUnitScope:
          orderUnit && view.rows.some((r) => r.ref === orderUnit) ? "customer" : "default",
        orderUnitLabel: view.rows.find((r) => r.ref === effective)?.label ?? "",
        tier,
        revision: p.priceRevision,
        rows: grid.map((row) => {
          const resolved = resolveCustomerUnitPrice({
            product,
            units: productUnits,
            viewOptions,
            customer: { tier, orderUnit, unitPrices },
            unit: row.ref,
          });
          const cell = (t: number) => roundMoney(row.cells.find((c) => c.tier === t)?.value ?? 0);
          // Sticky upsell: billing charges a remembered price ABOVE list on the pack, ahead of tier and promotions.
          const remembered = history[p.id]?.lastPrice;
          const sticky =
            row.kind === "pack" &&
            (resolved.source === "tier" || resolved.source === "list") &&
            remembered != null &&
            remembered > Number(p.pricePerUnit);
          return {
            ref: row.ref,
            label: row.label,
            factor: row.factor,
            kind: row.kind,
            code: unitCodeOf(codes, row.ref),
            price: sticky ? roundMoney(remembered) : resolved.price,
            listPrice: cell(1),
            tierPrice: cell(tier),
            source: sticky ? "history" : resolved.source,
          };
        }),
      };
    });

    return {
      customerId: customer.id,
      customerName: customer.businessName,
      tier: customerTierFor(null, customer.pricingTier) as PriceTierNumber,
      products: out,
      total,
      page,
      limit,
    };
  }
}
