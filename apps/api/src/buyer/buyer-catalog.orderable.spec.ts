import { Test } from "@nestjs/testing";
import { BuyerCatalogService } from "./buyer-catalog.service";
import { RegulatedVisibilityService } from "./regulated-visibility.service";
import { ReplenishmentService } from "./replenishment.service";
import { PrismaService } from "../prisma/prisma.service";
import { ProductsService } from "../products/products.service";
import { StorageService } from "../storage/storage.service";
import { OrdersService } from "../orders/orders.service";
import { PromotionsService } from "../promotions/promotions.service";
import { PolicyOversellReader } from "../orders/policy-oversell-reader";
import { createMockPrisma } from "../testing/prisma-mock";

/**
 * Buyer catalog `orderable` / `backorder` (SA-606k K1-K3): additive fields on every buyer product
 * (listing AND detail, so a tile and its page never disagree). `orderable` = the buyer may add it
 * (in stock, or out of stock while the seller backorders); `backorder` = it would be a backorder
 * (stock <= 0 while the policy allows). The policy is resolved ONCE per request for CUSTOMER /
 * source "buyer" / this customer - never per product.
 */
describe("BuyerCatalogService orderable / backorder", () => {
  let service: BuyerCatalogService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let products: { findAll: jest.Mock; findOne: jest.Mock };
  let read: jest.Mock;

  async function build(policy: unknown) {
    prisma = createMockPrisma();
    products = {
      findAll: jest.fn().mockResolvedValue({ data: [], meta: { total: 0 } }),
      findOne: jest.fn(),
    };
    read = jest.fn().mockResolvedValue(policy);
    const mod = await Test.createTestingModule({
      providers: [
        BuyerCatalogService,
        RegulatedVisibilityService,
        { provide: PrismaService, useValue: prisma },
        { provide: ProductsService, useValue: products },
        {
          provide: StorageService,
          useValue: { presignedUrl: jest.fn(), presignedUrls: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: OrdersService,
          useValue: { getCustomerPriceHistory: jest.fn().mockResolvedValue({}) },
        },
        { provide: ReplenishmentService, useValue: { estimates: jest.fn().mockResolvedValue([]) } },
        {
          provide: PromotionsService,
          useValue: { activeForCatalog: jest.fn().mockResolvedValue([]) },
        },
        { provide: PolicyOversellReader, useValue: { read } },
      ],
    }).compile();
    service = mod.get(BuyerCatalogService);
    prisma.customer.findUnique.mockResolvedValue({ pricingTier: 1 });
    prisma.trackedCategory.findMany.mockResolvedValue([]);
    prisma.customerPrice.findMany.mockResolvedValue([]);
  }

  const row = (id: string, currentStock: number) => ({
    id,
    name: id,
    unit: "ea",
    category: "Snacks",
    pricePerUnit: 10,
    currentStock,
    lowStockThreshold: 5,
    isActive: true,
    trackedCategoryId: null,
    imageKeys: [],
    variants: [],
  });
  const list = (rows: ReturnType<typeof row>[]) =>
    products.findAll.mockResolvedValue({ data: rows, meta: { total: rows.length } });

  it.each([
    ["backorder", 0, true, true],
    ["backorder", -3, true, true],
    ["backorder", 4, true, false],
    ["off", 0, false, false],
    ["off", 4, true, false],
    [undefined, 0, false, false],
  ])(
    "K1 listing, policy %p, stock %p -> orderable %p, backorder %p",
    async (policy, stock, orderable, backorder) => {
      await build(policy);
      list([row("p1", stock as number)]);
      const res = (await service.getCatalog({}, "c1")) as any;
      expect(res.data[0].orderable).toBe(orderable);
      expect(res.data[0].backorder).toBe(backorder);
    },
  );

  it("K2 the policy is read once for the whole page, as CUSTOMER of this customer", async () => {
    await build("backorder");
    list([row("p1", 0), row("p2", 3), row("p3", 0)]);
    await service.getCatalog({}, "c1");
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(expect.objectContaining({ customerId: "c1" }));
  });

  it("K1 detail: the same two fields, one read", async () => {
    await build("backorder");
    products.findOne.mockResolvedValue(row("p1", 0));
    const res = (await service.getProductDetail("p1", "c1")) as any;
    expect(res.orderable).toBe(true);
    expect(res.backorder).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("K3 additive only: the existing availability fields are unchanged", async () => {
    await build("backorder");
    list([row("p1", 0)]);
    const res = (await service.getCatalog({}, "c1")) as any;
    expect(res.data[0]).toMatchObject({
      inStock: false,
      stockStatus: "OUT_OF_STOCK",
      stockLeft: null,
    });
  });
});
