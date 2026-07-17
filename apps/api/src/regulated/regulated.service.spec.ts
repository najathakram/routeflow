import { Test } from "@nestjs/testing";
import { RegulatedService } from "./regulated.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";

describe("RegulatedService.getLedger", () => {
  let service: RegulatedService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [RegulatedService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = mod.get(RegulatedService);
    // groupBy isn't in the default mock surface — stub it for these tests.
    (prisma.regulatedSalesLedger as any).groupBy = jest.fn().mockResolvedValue([]);
  });

  const whereOf = () => (prisma.regulatedSalesLedger as any).groupBy.mock.calls[0][0].where;
  const byOf = () => (prisma.regulatedSalesLedger as any).groupBy.mock.calls[0][0].by;

  it("filters soldAt INCLUSIVELY (.lte) by default (user-facing /ledger)", async () => {
    await service.getLedger({ from: "2026-01-01T00:00:00.000Z", to: "2026-02-01T00:00:00.000Z" });
    const where = whereOf();
    expect(where.soldAt.gte).toEqual(new Date("2026-01-01T00:00:00.000Z"));
    expect(where.soldAt.lte).toEqual(new Date("2026-02-01T00:00:00.000Z"));
    expect(where.soldAt.lt).toBeUndefined();
  });

  it("filters soldAt EXCLUSIVELY (.lt) for exact half-open filing windows", async () => {
    await service.getLedger(
      { from: "2026-01-01T00:00:00.000Z", to: "2026-02-01T00:00:00.000Z" },
      { exclusiveTo: true },
    );
    const where = whereOf();
    expect(where.soldAt.lt).toEqual(new Date("2026-02-01T00:00:00.000Z"));
    expect(where.soldAt.lte).toBeUndefined();
  });

  // ─── RF-3: optional subcategory breakdown ─────────────────────────────────
  it("groups by section + period only by default (no subcategory dimension)", async () => {
    await service.getLedger({});
    expect(byOf()).toEqual(["trackedCategoryId", "periodBucket"]);
    const rows = (await service.getLedger({})).rows;
    expect(rows).toEqual([]); // default groupBy stub returns []
  });

  it("bySubcategory adds trackedSubcategoryId to the groupBy and joins the subcategory name", async () => {
    (prisma.regulatedSalesLedger as any).groupBy = jest.fn().mockResolvedValue([
      {
        trackedCategoryId: "cat-tob",
        trackedSubcategoryId: "sub-cig",
        periodBucket: "2026-07",
        _sum: { qty: 10, unitBasisQty: 10, netSales: 100, categoryTax: 0 },
      },
      {
        trackedCategoryId: "cat-tob",
        trackedSubcategoryId: null, // section-only rows keep a null subcategory
        periodBucket: "2026-07",
        _sum: { qty: 2, unitBasisQty: 2, netSales: 20, categoryTax: 0 },
      },
    ]);
    prisma.trackedCategory.findMany.mockResolvedValue([{ id: "cat-tob", name: "Tobacco" }]);
    prisma.trackedSubcategory.findMany.mockResolvedValue([{ id: "sub-cig", name: "Cigarettes" }]);

    const { rows } = await service.getLedger({ bySubcategory: true });

    expect(byOf()).toEqual(["trackedCategoryId", "trackedSubcategoryId", "periodBucket"]);
    // Only queries names for the non-null subcategory ids.
    expect(prisma.trackedSubcategory.findMany).toHaveBeenCalledWith({
      where: { id: { in: ["sub-cig"] } },
      select: { id: true, name: true },
    });
    expect(rows[0]).toMatchObject({
      trackedCategoryId: "cat-tob",
      categoryName: "Tobacco",
      trackedSubcategoryId: "sub-cig",
      subcategoryName: "Cigarettes",
      netSales: 100,
    });
    expect(rows[1]).toMatchObject({
      trackedSubcategoryId: null,
      subcategoryName: null, // null subcategory → no label
      netSales: 20,
    });
  });

  it("default rows carry NO subcategory keys (shape unchanged)", async () => {
    (prisma.regulatedSalesLedger as any).groupBy = jest.fn().mockResolvedValue([
      {
        trackedCategoryId: "cat-tob",
        periodBucket: "2026-07",
        _sum: { qty: 1, unitBasisQty: 1, netSales: 10, categoryTax: 0 },
      },
    ]);
    prisma.trackedCategory.findMany.mockResolvedValue([{ id: "cat-tob", name: "Tobacco" }]);

    const { rows } = await service.getLedger({});
    expect(rows[0]).not.toHaveProperty("trackedSubcategoryId");
    expect(rows[0]).not.toHaveProperty("subcategoryName");
    expect(prisma.trackedSubcategory.findMany).not.toHaveBeenCalled();
  });
});
