import { Test } from "@nestjs/testing";
import { BuyerDashboardService } from "./buyer-dashboard.service";
import { RegulatedVisibilityService } from "./regulated-visibility.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { createMockPrisma } from "../testing/prisma-mock";

describe("BuyerDashboardService — W7 gate", () => {
  let service: BuyerDashboardService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let visibility: { computeGate: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    (prisma.orderItem as any).groupBy = jest.fn().mockResolvedValue([]);
    visibility = { computeGate: jest.fn() };
    const mod = await Test.createTestingModule({
      providers: [
        BuyerDashboardService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: { presignedUrl: jest.fn() } },
        { provide: RegulatedVisibilityService, useValue: visibility },
      ],
    }).compile();
    service = mod.get(BuyerDashboardService);
    prisma.customer.findUnique.mockResolvedValue({ pricingTier: 1 });
  });

  it("excludes hidden regulated categories from the product surfaces", async () => {
    visibility.computeGate.mockResolvedValue({ hiddenIds: new Set(["cat-alc"]), locked: [] });
    await service.getDashboard("c1");
    const productCalls = prisma.product.findMany.mock.calls;
    expect(productCalls.length).toBeGreaterThanOrEqual(2); // new + featured
    for (const [args] of productCalls) {
      // the category-name lookup (select:category, no product display) is exempt
      if (args?.select?.category) continue;
      expect(args.where.trackedCategoryId).toEqual({ notIn: ["cat-alc"] });
    }
  });

  it("applies no exclusion on the fast path (nothing hidden)", async () => {
    visibility.computeGate.mockResolvedValue({ hiddenIds: new Set(), locked: [] });
    await service.getDashboard("c1");
    for (const [args] of prisma.product.findMany.mock.calls) {
      expect(args?.where?.trackedCategoryId).toBeUndefined();
    }
  });
});
