import { Test } from "@nestjs/testing";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { PromotionsService } from "./promotions.service";
import { FeatureConfigService } from "../billing/feature-config.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";

/** What a tenant-scoped read does: only this tenant's own rows come back for an id list. */
const ownRows = (owned: string[]) => async (args: { where: { id: { in: string[] } } }) =>
  args.where.id.in
    .filter((id) => owned.includes(id))
    .map((id) => ({ id, name: id, kind: "SIMPLE", category: "x", pricePerUnit: 10 }));

// 681 (R5-5) site 7: a promotion's product join rows store the caller's productIds. They must resolve inside
// the caller's tenant before the promotion or its join rows are written, ahead of the family policy and the
// zero-price scan, and before the write transaction opens.
describe("PromotionsService — tenant refs (681 site 7)", () => {
  let service: PromotionsService;
  let prisma: ReturnType<typeof createMockPrisma>;

  const base = {
    name: "Case deal",
    type: "PERCENT" as const,
    value: 8,
    scope: "PRODUCTS" as const,
    startsAt: "2026-07-01T00:00:00Z",
    endsAt: "2026-07-31T00:00:00Z",
  };

  beforeEach(async () => {
    prisma = createMockPrisma();
    prisma.product.findMany.mockImplementation(ownRows(["prod-a", "prod-a2"]));
    prisma.promotion.create.mockImplementation((a: any) =>
      Promise.resolve({ id: "promo-1", ...a.data }),
    );
    prisma.promotion.findUnique.mockResolvedValue({ id: "promo-1", ...base, products: [] });
    const mod = await Test.createTestingModule({
      providers: [
        PromotionsService,
        { provide: PrismaService, useValue: prisma },
        { provide: FeatureConfigService, useValue: { getEffectiveMode: async () => "on" } },
      ],
    }).compile();
    service = mod.get(PromotionsService);
  });

  describe("create", () => {
    it("another tenant's product in the set is a 404; no promotion, no join rows, no transaction", async () => {
      const err = await service
        .create({ ...base, productIds: ["prod-a", "prod-b"] })
        .catch((e) => e);
      expect(prisma.tenantTransaction).not.toHaveBeenCalled();
      expect(prisma.promotion.create).not.toHaveBeenCalled();
      expect(prisma.promotionProduct.createMany).not.toHaveBeenCalled();
      expect(err).toBeInstanceOf(NotFoundException);
      expect(err.message).toBe("Product not found");
    });

    it("control: this tenant's products write the promotion and its join rows", async () => {
      await service.create({ ...base, productIds: ["prod-a", "prod-a2"] });
      expect(prisma.promotion.create).toHaveBeenCalledTimes(1);
      expect(prisma.promotionProduct.createMany).toHaveBeenCalledTimes(1);
    });

    it("an ALL-scope promotion stores no product ids, so none are proven", async () => {
      await service.create({ ...base, scope: "ALL", productIds: ["prod-b"] });
      expect(prisma.promotion.create).toHaveBeenCalledTimes(1);
      expect(prisma.promotionProduct.createMany).not.toHaveBeenCalled();
    });

    it("the proof comes before the family policy", async () => {
      // Another tenant's id never reaches the family read: a miss and a foreign id are the same 404.
      prisma.product.findMany.mockImplementation(async () => []);
      const err = await service.create({ ...base, productIds: ["prod-b"] }).catch((e) => e);
      expect(err).toBeInstanceOf(NotFoundException);
      expect(err).not.toBeInstanceOf(BadRequestException);
    });
  });

  describe("update", () => {
    it("another tenant's product in the replacement set is a 404; the set is not deleted or rewritten", async () => {
      const err = await service.update("promo-1", { productIds: ["prod-b"] }).catch((e) => e);
      expect(prisma.tenantTransaction).not.toHaveBeenCalled();
      expect(prisma.promotionProduct.deleteMany).not.toHaveBeenCalled();
      expect(prisma.promotionProduct.createMany).not.toHaveBeenCalled();
      expect(prisma.promotion.update).not.toHaveBeenCalled();
      expect(err).toBeInstanceOf(NotFoundException);
      expect(err.message).toBe("Product not found");
    });

    it("control: this tenant's products replace the set", async () => {
      await service.update("promo-1", { productIds: ["prod-a"] });
      expect(prisma.promotionProduct.deleteMany).toHaveBeenCalledTimes(1);
      expect(prisma.promotionProduct.createMany).toHaveBeenCalledTimes(1);
    });

    it("a PATCH without productIds proves nothing", async () => {
      await service.update("promo-1", { name: "Renamed" });
      expect(prisma.promotion.update).toHaveBeenCalledTimes(1);
    });
  });
});
