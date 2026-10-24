import { Test } from "@nestjs/testing";
import { PrismaService } from "../prisma/prisma.service";
import { ProductLabelsService } from "../product-labels/product-labels.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { SellingRestrictionsService } from "./selling-restrictions.service";

/**
 * L8 M1 (owner ruling 2026-10-14): which state hides products in the BUYER PORTAL follows the tenant's fulfilment
 * model. A PICKUP-ONLY tenant is judged on the STORE state (unset store state: restricted products hidden, fail
 * closed); a tenant that ships keeps the buyer's governing state (the 10-12 rule).
 */
const T = "tenant-1";
const NOW = new Date("2026-10-14T12:00:00Z");

describe("restrictedProductIdsFor: the portal hides by the fulfilment model's state (L8 M1)", () => {
  let service: SellingRestrictionsService;
  let prisma: any;

  const rule = (states: string[], surface = "ALL") => ({
    id: "r1",
    categoryId: null,
    productId: "p1",
    jurisdiction: "STATE",
    states,
    surface,
    effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    effectiveTo: null,
    liftedAt: null,
    reason: "State ban",
    targets: [],
    _count: { targets: 0 },
  });
  const model = (mode: string | null) =>
    prisma.tenantFeatureConfig.findFirst.mockResolvedValue(mode ? { mode } : null);
  const storeIn = (state: string | null) =>
    prisma.tenantConfig.findUnique.mockResolvedValue(state === null ? null : { state });
  const hidden = async () => [...(await service.restrictedProductIdsFor(T, "c-ca", NOW))];

  beforeEach(async () => {
    const mock: any = createMockPrisma();
    mock.getTenantId.mockReturnValue(null);
    prisma = mock.forTenant();
    prisma.sellingRestriction = { findMany: jest.fn().mockResolvedValue([]) };
    prisma.productCategory = { findMany: jest.fn().mockResolvedValue([]) };
    prisma.productCategoryLabel = { findMany: jest.fn().mockResolvedValue([]) };
    prisma.systemConfig.findMany.mockResolvedValue([]);
    prisma.systemConfig.findFirst.mockResolvedValue(null);
    prisma.product.findMany.mockResolvedValue([
      { id: "p1", name: "Gummies", parentProductId: null, categoryLabels: [] },
    ]);
    prisma.customer.findFirst.mockResolvedValue({
      isWalkIn: false,
      addresses: [
        { isDefault: true, addressType: "BILLING", stateCode: "CA", stateNeedsReview: false },
      ],
    });
    const mod = await Test.createTestingModule({
      providers: [
        SellingRestrictionsService,
        ProductLabelsService,
        { provide: PrismaService, useValue: mock },
      ],
    }).compile();
    service = mod.get(SellingRestrictionsService);
  });

  describe("a PICKUP-ONLY tenant, CA buyer, store in TX", () => {
    beforeEach(() => {
      model("pickup");
      storeIn("TX");
    });
    it("a CA-only ban does NOT hide (the buyer's state is not consulted)", async () => {
      prisma.sellingRestriction.findMany.mockResolvedValue([rule(["CA"])]);
      expect(await hidden()).toEqual([]);
    });
    it("a TX ban hides", async () => {
      prisma.sellingRestriction.findMany.mockResolvedValue([rule(["TX"])]);
      expect(await hidden()).toEqual(["p1"]);
    });
    it("an unset store state hides the restricted product, even for a portal-only limit", async () => {
      storeIn(null);
      prisma.sellingRestriction.findMany.mockResolvedValue([rule(["NY"], "BUYER_PORTAL")]);
      expect(await hidden()).toEqual(["p1"]);
    });
    it("an anonymous (no customer) reader is judged by the store too", async () => {
      prisma.sellingRestriction.findMany.mockResolvedValue([rule(["TX"], "BUYER_PORTAL")]);
      expect([...(await service.restrictedProductIdsFor(T, null, NOW))]).toEqual(["p1"]);
    });
  });

  describe("a MIXED pickup+ship tenant (and one that never set a model), CA buyer, store in TX", () => {
    it.each(["pickup_ship", "both", "ship", null])(
      "%s: a CA-banned product is hidden",
      async (m) => {
        model(m);
        storeIn("TX");
        prisma.sellingRestriction.findMany.mockResolvedValue([rule(["CA"])]);
        expect(await hidden()).toEqual(["p1"]);
      },
    );
    it("pickup_ship: a TX-only ban does NOT hide from a CA buyer", async () => {
      model("pickup_ship");
      storeIn("TX");
      prisma.sellingRestriction.findMany.mockResolvedValue([rule(["TX"])]);
      expect(await hidden()).toEqual([]);
    });
  });

  it("a STORE-judged sale with NO store state is INDETERMINATE even for a portal-only STATE rule", async () => {
    storeIn(null);
    prisma.sellingRestriction.findMany.mockResolvedValue([rule(["NY"], "BUYER_PORTAL")]);
    const res = await service.evaluate(T, "c-ca", [{ productId: "p1" }], {
      channel: "BUYER_PORTAL",
      at: NOW,
      fulfilmentKind: "PICKUP",
    });
    expect(res.outcome).toBe("INDETERMINATE");
    // a DELIVERY sale to a customer with no state keeps the owner's portal-only allowance
    prisma.customer.findFirst.mockResolvedValue({ isWalkIn: false, addresses: [] });
    const delivery = await service.evaluate(T, "c-none", [{ productId: "p1" }], {
      channel: "BUYER_PORTAL",
      at: NOW,
      fulfilmentKind: "DELIVERY",
    });
    expect(delivery.outcome).toBe("ALLOW");
  });

  it("the fulfilment model is read only when a STATE rule is in play (the common case stays one query)", async () => {
    prisma.sellingRestriction.findMany.mockResolvedValue([]);
    await hidden();
    expect(prisma.tenantFeatureConfig.findFirst).not.toHaveBeenCalled();
  });
});
