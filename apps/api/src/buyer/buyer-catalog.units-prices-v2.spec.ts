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

const V2 = "flag.units_prices_v2";
let v2On = true;

describe("BuyerCatalogService — the tile shows the customer-layer price the cart charges (S19)", () => {
  let service: BuyerCatalogService;
  let restrictions: { restrictedProductIdsFor: jest.Mock };
  let backorderResolve: jest.Mock;
  const viewIs = (v: BuyerBackorderView) => backorderResolve.mockResolvedValue(v);
  let prisma: ReturnType<typeof createMockPrisma>;
  let products: { findAll: jest.Mock; findOne: jest.Mock };
  let ordersService: { getCustomerPriceHistory: jest.Mock; entitlements: unknown };
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
    const flagRead = jest.fn(async (_t: string, k: string) => k === V2 && v2On);
    ordersService = {
      getCustomerPriceHistory: jest.fn().mockResolvedValue({}),
      entitlements: { hasFlag: flagRead, hasFlagStrict: flagRead },
    } as never;
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

  const tile = async (typedPrice: number, history?: number) => {
    prisma.trackedCategory.findMany.mockResolvedValue([]);
    products.findAll.mockResolvedValue({
      data: [{ id: "p1", name: "Widget", unit: "ea", pricePerUnit: 10, currentStock: 5 }],
      meta: { total: 1 },
    });
    prisma.customerPrice.findMany.mockResolvedValue([]);
    (prisma.forTenant() as any).customerUnitPrice = {
      findMany: jest
        .fn()
        .mockResolvedValue([{ productId: "p1", unitRef: "pack", price: String(typedPrice) }]),
    };
    ordersService.getCustomerPriceHistory.mockResolvedValue(
      history ? { p1: { lastPrice: history, listPriceAtTime: 10 } } : {},
    );
    return ((await service.getCatalog({}, "c1")) as any).data[0].buyerPrice;
  };

  it("flag on: the tile shows the typed pack price (the cart charges it), above a remembered upsell", async () => {
    v2On = true;
    expect(await tile(7, 12)).toBe(7);
  });

  it("flag on: a typed price above list is the tile price too (never hidden behind the tier)", async () => {
    v2On = true;
    expect(await tile(11)).toBe(11);
  });

  it("flag OFF with typed rows present: master's tile (the sticky upsell, else the tier price)", async () => {
    v2On = false;
    expect(await tile(7, 12)).toBe(12);
    expect(await tile(7)).toBe(10);
    expect((ordersService.entitlements as any).hasFlag).toHaveBeenCalledWith(expect.anything(), V2);
  });
});
