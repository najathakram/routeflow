import { noRestrictionsProvider } from "../selling-restrictions/testing/no-restrictions-provider";
import { Test } from "@nestjs/testing";
import { BuyerDashboardService } from "./buyer-dashboard.service";
import { RegulatedVisibilityService } from "./regulated-visibility.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { createMockPrisma } from "../testing/prisma-mock";

/**
 * S19b A-2 (SA-811a, SA-813 Q2): a dashboard tile shows what the cart charges. A typed pack $33 (list $42, the customer on
 * tier 3, whose column is $39) shows $33 flag-on and master's tier-3 $39 flag-off. Tiles keep master's no-sticky behaviour.
 */
const V2 = "flag.units_prices_v2";
const PRODUCT = {
  id: "p1",
  name: "Cola",
  sku: "S1",
  unit: "Box",
  category: "Soda",
  imageKeys: [],
  unitsPerBox: 24,
  pricePerUnit: 42,
  priceTier2: 40,
  priceTier3: 39,
  priceTier4: 0,
  priceTier5: 0,
  orderUnitRef: "pack",
  packAuto: 0,
};

describe("BuyerDashboardService tiles: the customer layer (S19b A-2)", () => {
  let service: BuyerDashboardService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let v2On = true;
  const hasFlag = jest.fn(async (_t: string, k: string) => k === V2 && v2On);

  beforeEach(async () => {
    prisma = createMockPrisma();
    (prisma.orderItem as any).groupBy = jest.fn().mockResolvedValue([]);
    const mod = await Test.createTestingModule({
      providers: [
        BuyerDashboardService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: { presignedUrl: jest.fn() } },
        {
          provide: RegulatedVisibilityService,
          useValue: {
            computeGate: jest.fn().mockResolvedValue({ hiddenIds: new Set(), locked: [] }),
          },
        },
        { provide: EntitlementsService, useValue: { hasFlag, hasFlagStrict: hasFlag } },
        noRestrictionsProvider,
      ],
    }).compile();
    service = mod.get(BuyerDashboardService);
    hasFlag.mockClear();
    prisma.customer.findFirst.mockResolvedValue({ pricingTier: 3 });
    prisma.product.findMany.mockResolvedValue([PRODUCT]);
    prisma.customerPrice.findMany.mockResolvedValue([]);
    // the frequently-ordered group is driven by the order-item groupBy
    (prisma.orderItem as any).groupBy = jest
      .fn()
      .mockResolvedValue([{ productId: "p1", _count: { productId: 2 }, _sum: { qty: 4 } }]);
  });

  const typed = (price: number) => {
    (prisma.forTenant() as any).customerUnitPrice = {
      findMany: jest
        .fn()
        .mockResolvedValue([{ productId: "p1", unitRef: "pack", price: String(price) }]),
    };
  };
  const tiles = async () => {
    const res: any = await service.getDashboard("c1");
    return tileGroups(res).flatMap((g: any[]) => g.map((t: any) => t.buyerPrice));
  };
  /** All four tile groups: frequently ordered, new, featured, suggested. */
  const tileGroups = (res: any): any[][] => [
    res.frequentlyOrdered,
    res.newFromSeller,
    res.featuredItems,
    res.suggestedItems,
  ];

  it("every one of the FOUR tile groups is populated, so the prices below are not vacuous", async () => {
    v2On = true;
    typed(33);
    const res: any = await service.getDashboard("c1");
    for (const g of tileGroups(res)) expect(g.length).toBeGreaterThan(0);
  });

  it("flag on: every tile group shows the typed pack price $33", async () => {
    v2On = true;
    typed(33);
    const prices = await tiles();
    expect(prices.length).toBeGreaterThan(0);
    expect(new Set(prices)).toEqual(new Set([33]));
  });

  it("flag OFF with a typed row present: master's tier-3 price $39, the flag was asked", async () => {
    v2On = false;
    typed(33);
    const prices = await tiles();
    expect(prices.length).toBeGreaterThan(0);
    expect(new Set(prices)).toEqual(new Set([39]));
    expect(hasFlag).toHaveBeenCalledWith(expect.anything(), V2);
  });

  it("no typed row: master's $39 and the flag is never asked", async () => {
    v2On = true;
    const prices = await tiles();
    expect(new Set(prices)).toEqual(new Set([39]));
    expect(hasFlag).not.toHaveBeenCalledWith(expect.anything(), V2);
  });
});
