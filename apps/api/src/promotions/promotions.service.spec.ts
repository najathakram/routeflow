import { Test } from "@nestjs/testing";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { PromotionsService } from "./promotions.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";

describe("PromotionsService", () => {
  let service: PromotionsService;
  let prisma: ReturnType<typeof createMockPrisma>;

  const base = {
    name: "Case deal",
    type: "PERCENT" as const,
    value: 8,
    scope: "ALL" as const,
    startsAt: "2026-07-01T00:00:00Z",
    endsAt: "2026-07-31T00:00:00Z",
  };

  beforeEach(async () => {
    prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [PromotionsService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = mod.get(PromotionsService);
    prisma.promotion.create.mockImplementation((a: any) =>
      Promise.resolve({ id: "promo-1", ...a.data }),
    );
    prisma.promotion.findUnique.mockResolvedValue({ id: "promo-1", ...base, products: [] });
  });

  it("creates an ALL-scope percent promotion", async () => {
    await service.create({ ...base });
    expect(prisma.promotion.create).toHaveBeenCalledTimes(1);
    const data = prisma.promotion.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ name: "Case deal", type: "PERCENT", value: 8, scope: "ALL" });
    // ALL scope writes no product join rows
    expect(prisma.promotionProduct.createMany).not.toHaveBeenCalled();
  });

  it("writes product join rows for a PRODUCTS-scoped promotion", async () => {
    await service.create({ ...base, scope: "PRODUCTS", productIds: ["p1", "p2"] });
    expect(prisma.promotionProduct.createMany).toHaveBeenCalledTimes(1);
    const rows = prisma.promotionProduct.createMany.mock.calls[0][0].data;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      promotionId: "promo-1",
      productId: "p1",
      tenantId: "test-tenant",
    });
  });

  it("rejects a QTY_BREAK without a minQty", async () => {
    await expect(service.create({ ...base, type: "QTY_BREAK" })).rejects.toThrow(
      BadRequestException,
    );
  });

  // BUY_N_GET_M ("buy 5, get the 6th free") reuses minQty=N, value=M — both required
  // as positive integers for this type (owner misconfiguration that started this
  // feature was exactly a missing guard here: a promo that can't express N/M got
  // shoehorned into FIXED $off, $0-ing 40% of the catalog).
  it("creates a BUY_N_GET_M promotion with integer minQty (N) + value (M)", async () => {
    await service.create({ ...base, type: "BUY_N_GET_M", minQty: 5, value: 1 });
    expect(prisma.promotion.create).toHaveBeenCalledTimes(1);
    const data = prisma.promotion.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ type: "BUY_N_GET_M", minQty: 5, value: 1 });
  });

  it("rejects a BUY_N_GET_M without a minQty (N)", async () => {
    await expect(service.create({ ...base, type: "BUY_N_GET_M", value: 1 })).rejects.toThrow(
      /buy quantity \(minQty\)/,
    );
  });

  it("rejects a BUY_N_GET_M with a fractional minQty (N)", async () => {
    await expect(
      service.create({ ...base, type: "BUY_N_GET_M", minQty: 5.5, value: 1 }),
    ).rejects.toThrow(/buy quantity \(minQty\)/);
  });

  it("rejects a BUY_N_GET_M with minQty (N) < 1", async () => {
    await expect(
      service.create({ ...base, type: "BUY_N_GET_M", minQty: 0, value: 1 }),
    ).rejects.toThrow(/buy quantity \(minQty\)/);
  });

  it("rejects a BUY_N_GET_M without a value (M)", async () => {
    // `base.value` (8) would otherwise satisfy the integer>=1 check — explicitly
    // blank it so this pins the "missing M" case, not "M present from base".
    await expect(
      service.create({ ...base, type: "BUY_N_GET_M", minQty: 5, value: undefined as any }),
    ).rejects.toThrow(/free quantity \(value\)/);
  });

  it("rejects a BUY_N_GET_M with a fractional value (M)", async () => {
    await expect(
      service.create({ ...base, type: "BUY_N_GET_M", minQty: 5, value: 1.5 }),
    ).rejects.toThrow(/free quantity \(value\)/);
  });

  it("rejects a BUY_N_GET_M with value (M) < 1", async () => {
    await expect(
      service.create({ ...base, type: "BUY_N_GET_M", minQty: 5, value: 0 }),
    ).rejects.toThrow(/free quantity \(value\)/);
  });

  it("rejects a CATEGORY scope without a category", async () => {
    await expect(service.create({ ...base, scope: "CATEGORY" })).rejects.toThrow(
      /require a category/,
    );
  });

  it("rejects a PRODUCTS scope with no productIds", async () => {
    await expect(service.create({ ...base, scope: "PRODUCTS", productIds: [] })).rejects.toThrow(
      /at least one productId/,
    );
  });

  it("rejects an end date at/before the start", async () => {
    await expect(service.create({ ...base, endsAt: "2026-07-01T00:00:00Z" })).rejects.toThrow(
      /endsAt must be after startsAt/,
    );
  });

  it("findOne 404s a missing promotion", async () => {
    prisma.promotion.findUnique.mockResolvedValue(null);
    await expect(service.findOne("nope")).rejects.toThrow(NotFoundException);
  });

  it("activeForCatalog returns in-window promos with flattened productIds", async () => {
    prisma.promotion.findMany.mockResolvedValue([
      {
        id: "promo-1",
        name: "Case deal",
        bannerText: "8% off cases of 8+",
        type: "QTY_BREAK",
        value: 8,
        minQty: 8,
        scope: "ALL",
        category: null,
        startsAt: new Date("2026-07-01T00:00:00Z"),
        endsAt: new Date("2026-07-31T00:00:00Z"),
        products: [{ productId: "p1" }, { productId: "p2" }],
      },
    ]);
    const out = await service.activeForCatalog(new Date("2026-07-15T00:00:00Z"));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "promo-1", value: 8, minQty: 8, productIds: ["p1", "p2"] });
    // the DB query is bounded to active + in-window
    const where = prisma.promotion.findMany.mock.calls[0][0].where;
    expect(where.isActive).toBe(true);
    expect(where.startsAt.lte).toBeInstanceOf(Date);
    expect(where.endsAt.gte).toBeInstanceOf(Date);
  });
});
