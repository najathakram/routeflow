/**
 * Inventory W0 / B4 - hide mode leaks no stock (catalog + cart + detail side).
 *
 * Seller chose `orders.buyerBackorderVisibility = "hide"` and this buyer CAN backorder. Lead ruling:
 * `canBackorder` on each row stays, per SA-714 R2 (the per-line marker). What must NOT reach the
 * buyer is any stock count or stock-status signal: the raw columns (quantity, currentStock,
 * lowStockThreshold, ...) never appear, and the three display fields the tile renders (`inStock`,
 * `stockStatus`, `stockLeft`) carry the SAME masked value on every row whatever the real stock is
 * (SA-714 R3: the item looks in stock), so no row tells the buyer anything about its stock.
 * Swept over the catalog list, the cart (the catalog read by `ids`) and the product detail incl.
 * its variants. Existing buyer-catalog.service.spec is untouched.
 */
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { noRestrictionsProvider } from "../selling-restrictions/testing/no-restrictions-provider";
import { Test } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { BuyerCatalogService } from "./buyer-catalog.service";
import { RegulatedVisibilityService } from "./regulated-visibility.service";
import { ReplenishmentService } from "./replenishment.service";
import { PrismaService } from "../prisma/prisma.service";
import { ProductsService } from "../products/products.service";
import { StorageService } from "../storage/storage.service";
import { OrdersService } from "../orders/orders.service";
import {
  BuyerBackorderViewResolver,
  NO_BACKORDER_VIEW,
  type BuyerBackorderView,
} from "../orders/buyer-backorder-view";
import { PromotionsService } from "../promotions/promotions.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { buyerVisibleProductWhere, noBuyerRestrictions } from "./buyer-product-visibility";

// The one shared buyer-visibility clause getCatalog always appends to findAll's andWhere.
// The mock prisma's tenant ("test-tenant") scopes the parent filters (B1211).
const VIS = buyerVisibleProductWhere(noBuyerRestrictions("test-tenant"));

describe("B4: hide mode - the buyer catalog, cart and detail leak no stock signal", () => {
  let service: BuyerCatalogService;
  let restrictions: { restrictedProductIdsFor: jest.Mock };
  let backorderResolve: jest.Mock;
  const viewIs = (v: BuyerBackorderView) => backorderResolve.mockResolvedValue(v);
  let prisma: ReturnType<typeof createMockPrisma>;
  let products: { findAll: jest.Mock; findOne: jest.Mock };
  let ordersService: { getCustomerPriceHistory: jest.Mock };
  let storage: { presignedUrl: jest.Mock; presignedUrls: jest.Mock };
  let replenishment: { estimates: jest.Mock };
  let promotions: { activeForCatalog: jest.Mock };

  const future = new Date(Date.now() + 365 * 864e5);
  const past = new Date(Date.now() - 864e5);

  beforeEach(async () => {
    prisma = createMockPrisma();
    products = {
      findAll: jest.fn().mockResolvedValue({ data: [], meta: { total: 0 } }),
      findOne: jest.fn(),
    };
    ordersService = { getCustomerPriceHistory: jest.fn().mockResolvedValue({}) };
    storage = { presignedUrl: jest.fn(), presignedUrls: jest.fn().mockResolvedValue([]) };
    replenishment = { estimates: jest.fn().mockResolvedValue([]) };
    promotions = { activeForCatalog: jest.fn().mockResolvedValue([]) };
    backorderResolve = jest.fn().mockResolvedValue(NO_BACKORDER_VIEW);
    const mod = await Test.createTestingModule({
      providers: [
        BuyerCatalogService,
        RegulatedVisibilityService,
        { provide: PrismaService, useValue: prisma },
        { provide: ProductsService, useValue: products },
        { provide: StorageService, useValue: storage },
        { provide: OrdersService, useValue: ordersService },
        { provide: ReplenishmentService, useValue: replenishment },
        { provide: PromotionsService, useValue: promotions },
        { provide: BuyerBackorderViewResolver, useValue: { resolve: backorderResolve } },
        noRestrictionsProvider,
      ],
    }).compile();
    service = mod.get(BuyerCatalogService);
    restrictions = mod.get(SellingRestrictionsService) as unknown as typeof restrictions;
    prisma.customer.findUnique.mockResolvedValue({ pricingTier: 1 });
  });

  // Three real stock states: low (3.5 <= threshold 5), empty (0), plenty (50).
  const rows = () =>
    products.findAll.mockResolvedValue({
      data: [
        {
          id: "p1",
          name: "A",
          unit: "ea",
          pricePerUnit: 10,
          currentStock: 3.5,
          lowStockThreshold: 5,
        },
        { id: "p2", name: "B", unit: "ea", pricePerUnit: 10, currentStock: 0 },
        { id: "p3", name: "C", unit: "ea", pricePerUnit: 10, currentStock: 50 },
      ],
      meta: { total: 3, page: 1, limit: 20, totalPages: 1 },
    });

  /** The masked display triple (SA-714 R3) and the flag SA-714 R2 keeps: the only stock-ish keys allowed. */
  const ALLOWED = new Set(["inStock", "stockStatus", "stockLeft", "canBackorder"]);
  const STOCKISH = /stock|quantity|qty|availab|inventory|onhand|on_hand|remaining|threshold/i;

  /** Every path (dotted) of a stock-ish key outside the allowed set, at any depth. */
  function stockKeys(value: unknown, path = "$"): string[] {
    if (Array.isArray(value)) return value.flatMap((v, i) => stockKeys(v, `${path}[${i}]`));
    if (value && typeof value === "object" && !(value instanceof Date)) {
      return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => [
        ...(STOCKISH.test(k) && !ALLOWED.has(k) ? [`${path}.${k}`] : []),
        ...stockKeys(v, `${path}.${k}`),
      ]);
    }
    return [];
  }

  const triples = (data: Array<Record<string, unknown>>) =>
    data.map((p) => [p.inStock, p.stockStatus, p.stockLeft]);

  beforeEach(() => {
    prisma.trackedCategory.findMany.mockResolvedValue([]);
    backorderResolve.mockResolvedValue({ canBackorder: true, visibility: "hide" });
  });

  it.each([
    ["catalog list", {}],
    ["cart read (catalog by ids)", { ids: ["p1", "p2", "p3"], limit: 20 }],
  ])("%s: no raw stock key, and every row shows the same masked triple", async (_n, query) => {
    rows();
    const res = (await service.getCatalog(query as never, "c1")) as unknown as {
      data: Array<Record<string, unknown>>;
    };
    expect(stockKeys(res)).toEqual([]);
    expect(triples(res.data)).toEqual([
      [true, "IN_STOCK", null],
      [true, "IN_STOCK", null],
      [true, "IN_STOCK", null],
    ]);
    // R2: the per-line flag stays.
    expect(res.data.map((p) => p.canBackorder)).toEqual([true, true, true]);
  });

  it("product detail (and its variants): no raw stock key, masked triple even at stock 0", async () => {
    prisma.customerPrice.findMany.mockResolvedValue([]);
    products.findOne.mockResolvedValue({
      id: "p1",
      tenantId: "test-tenant",
      kind: "STANDARD",
      portalVisible: true,
      parent: null,
      name: "Widget",
      unit: "ea",
      category: "Snacks",
      pricePerUnit: 10,
      currentStock: 0,
      lowStockThreshold: 5,
      isActive: true,
      trackedCategoryId: null,
      imageKeys: [],
      imageUrls: [],
      variants: [
        {
          id: "v1",
          isActive: true,
          kind: "STANDARD",
          portalVisible: true,
          variantName: "Large",
          sku: "V1",
          unit: "ea",
          pricePerUnit: 12,
          category: "Snacks",
          unitsPerBox: 6,
          currentStock: 2,
        },
      ],
    });
    const res = (await service.getProductDetail("p1", "c1")) as unknown as Record<string, unknown>;
    expect(stockKeys(res)).toEqual([]);
    expect([res.inStock, res.stockStatus, res.stockLeft]).toEqual([true, "IN_STOCK", null]);
  });

  it("the sweep is not vacuous: it flags a raw stock key and ignores the allowed ones", () => {
    expect(stockKeys({ data: [{ currentStock: 3, inStock: true, canBackorder: true }] })).toEqual([
      "$.data[0].currentStock",
    ]);
  });
});
