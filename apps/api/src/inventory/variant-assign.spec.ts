import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { InventoryService } from "./inventory.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { StockAlertService } from "../stock-alerts/stock-alert.service";

/**
 * PR-D: InventoryService.assignToVariants — moving stock atomically from a
 * generic parent product to its variants. See
 * .claude/pipeline/plans/2026-08-20-pr-d-variant-split.md WP1 for the spec
 * this file pins.
 */

const D = (n: number | string) => new Prisma.Decimal(n);

const parent = (overrides: Record<string, unknown> = {}) => ({
  id: "parent-1",
  name: "Cola 24pk",
  unit: "case",
  parentProductId: null,
  currentStock: D(20),
  averageCost: D(4),
  standardCost: null,
  costingMethod: "AVCO",
  unitsPerBox: 12,
  pricePerUnit: D(30),
  priceTier2: D(28),
  priceTier3: D(26),
  priceTier4: D(24),
  priceTier5: D(22),
  category: "Beverages",
  isTobacco: false,
  trackedCategoryId: null,
  trackedSubcategoryId: null,
  regItemType: null,
  regUomCase: null,
  regUomUnit: null,
  ...overrides,
});

const variant = (overrides: Record<string, unknown> = {}) => ({
  id: "variant-1",
  name: "Cola 24pk - Cherry",
  variantName: "Cherry",
  parentProductId: "parent-1",
  currentStock: D(0),
  averageCost: null,
  costingMethod: "AVCO",
  ...overrides,
});

describe("InventoryService.assignToVariants", () => {
  let service: InventoryService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InventoryService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: StockAlertService,
          useValue: { fireForProducts: jest.fn().mockResolvedValue({ notified: 0 }) },
        },
      ],
    }).compile();

    service = module.get<InventoryService>(InventoryService);
  });

  it("throws 400 INSUFFICIENT_UNASSIGNED and writes nothing when the total exceeds the parent's stock", async () => {
    prisma.product.findUnique.mockResolvedValue(parent({ currentStock: D(10) }));

    const err = await service
      .assignToVariants(
        { parentProductId: "parent-1", assignments: [{ productId: "variant-1", qty: 15 }] } as any,
        "user-1",
      )
      .catch((e) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect((err.getResponse() as { code: string }).code).toBe("INSUFFICIENT_UNASSIGNED");

    expect(prisma.product.findFirst).not.toHaveBeenCalled();
    expect(prisma.product.create).not.toHaveBeenCalled();
    expect(prisma.product.update).not.toHaveBeenCalled();
    expect(prisma.stockMovement.create).not.toHaveBeenCalled();
    expect(prisma.stockLot.create).not.toHaveBeenCalled();
    expect(prisma.stockLot.update).not.toHaveBeenCalled();
  });

  it("leaves the correct remainder on the parent for a partial assignment", async () => {
    prisma.product.findUnique.mockResolvedValue(parent({ currentStock: D(20) }));
    prisma.product.findFirst.mockResolvedValue(variant());

    const result = await service.assignToVariants(
      { parentProductId: "parent-1", assignments: [{ productId: "variant-1", qty: 5 }] } as any,
      "user-1",
    );

    expect(result.parentRemaining).toBe(15);
    const parentUpdate = prisma.product.update.mock.calls.find(
      (c: any) => c[0].where.id === "parent-1",
    )!;
    expect(parentUpdate[0].data.currentStock.decrement.toString()).toBe("5");
  });

  it("writes one negative parent ADJUSTMENT for the total and one positive per variant, all sharing one VARIANT_ASSIGN- reference", async () => {
    prisma.product.findUnique.mockResolvedValue(parent({ currentStock: D(20) }));
    prisma.product.findFirst
      .mockResolvedValueOnce(variant({ id: "variant-1" }))
      .mockResolvedValueOnce(variant({ id: "variant-2", name: "Cola 24pk - Diet" }));

    const result = await service.assignToVariants(
      {
        parentProductId: "parent-1",
        assignments: [
          { productId: "variant-1", qty: 5 },
          { productId: "variant-2", qty: 3 },
        ],
      } as any,
      "user-1",
    );

    expect(result.reference).toMatch(/^VARIANT_ASSIGN-/);
    expect(prisma.stockMovement.create).toHaveBeenCalledTimes(3);

    const calls = prisma.stockMovement.create.mock.calls.map((c: any) => c[0].data);
    expect(calls.every((d: any) => d.type === "ADJUSTMENT")).toBe(true);
    expect(calls.every((d: any) => d.reference === result.reference)).toBe(true);

    const parentMovement = calls.find((d: any) => d.productId === "parent-1")!;
    expect(parentMovement.quantity.toString()).toBe("-8");

    const variantMovements = calls.filter((d: any) => d.productId !== "parent-1");
    expect(variantMovements).toHaveLength(2);
    expect(variantMovements.map((d: any) => d.quantity.toString()).sort()).toEqual(["3", "5"]);
  });

  it("rejects a target that is not a child of this parent with 400", async () => {
    prisma.product.findUnique.mockResolvedValue(parent({ currentStock: D(20) }));
    prisma.product.findFirst.mockResolvedValue(null);

    const err = await service
      .assignToVariants(
        {
          parentProductId: "parent-1",
          assignments: [{ productId: "unrelated-product", qty: 5 }],
        } as any,
        "user-1",
      )
      .catch((e) => e);

    expect(err).toBeInstanceOf(BadRequestException);
  });

  it("rejects splitting a product that is itself a variant with 400", async () => {
    prisma.product.findUnique.mockResolvedValue(
      parent({ id: "child-1", parentProductId: "grandparent-1" }),
    );

    const err = await service
      .assignToVariants(
        { parentProductId: "child-1", assignments: [{ productId: "variant-1", qty: 1 }] } as any,
        "user-1",
      )
      .catch((e) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect(prisma.product.findFirst).not.toHaveBeenCalled();
  });

  it("converts a boxed generic's {boxes, pieces} to base units against the parent's unitsPerBox", async () => {
    prisma.product.findUnique.mockResolvedValue(parent({ currentStock: D(100), unitsPerBox: 12 }));
    prisma.product.findFirst.mockResolvedValue(variant());

    const result = await service.assignToVariants(
      {
        parentProductId: "parent-1",
        assignments: [{ productId: "variant-1", boxes: 2, pieces: 3 }],
      } as any,
      "user-1",
    );

    expect(result.assignments[0].qty).toBe(27); // 2*12 + 3, NOT 2
    const variantMovement = prisma.stockMovement.create.mock.calls
      .map((c: any) => c[0].data)
      .find((d: any) => d.productId === "variant-1")!;
    expect(variantMovement.quantity.toString()).toBe("27");
  });

  it("costs a variant at unitCostOverride when given, and at the parent's averageCost otherwise", async () => {
    prisma.product.findUnique.mockResolvedValue(parent({ currentStock: D(20), averageCost: D(4) }));
    prisma.product.findFirst
      .mockResolvedValueOnce(variant({ id: "variant-1" }))
      .mockResolvedValueOnce(variant({ id: "variant-2" }));
    // Lots covering the whole transfer — variant lots are only opened for the
    // quantity the parent's lots actually gave up.
    prisma.stockLot.findMany.mockResolvedValue([
      { id: "lot-a", remainingQty: D(20), unitCost: D(4) },
    ]);

    const result = await service.assignToVariants(
      {
        parentProductId: "parent-1",
        assignments: [
          { productId: "variant-1", qty: 5, unitCostOverride: 7.5 },
          { productId: "variant-2", qty: 3 },
        ],
      } as any,
      "user-1",
    );

    const overridden = result.assignments.find((a) => a.productId === "variant-1")!;
    const fallback = result.assignments.find((a) => a.productId === "variant-2")!;
    expect(overridden.unitCost).toBe(7.5);
    expect(fallback.unitCost).toBe(4);

    const lotCosts = prisma.stockLot.create.mock.calls.map((c: any) =>
      c[0].data.unitCost.toString(),
    );
    expect(lotCosts.sort()).toEqual(["4", "7.5"]);
  });

  it("never overwrites a STANDARD-costed variant's averageCost", async () => {
    prisma.product.findUnique.mockResolvedValue(parent({ currentStock: D(20), averageCost: D(4) }));
    prisma.product.findFirst.mockResolvedValue(
      variant({ costingMethod: "STANDARD", averageCost: D(9.99), currentStock: D(2) }),
    );

    await service.assignToVariants(
      { parentProductId: "parent-1", assignments: [{ productId: "variant-1", qty: 5 }] } as any,
      "user-1",
    );

    const variantUpdate = prisma.product.update.mock.calls.find(
      (c: any) => c[0].where.id === "variant-1",
    )!;
    expect(variantUpdate[0].data.averageCost).toBeUndefined();

    // Snapshot carries the UNCHANGED average forward, not the resolved cost.
    const variantMovement = prisma.stockMovement.create.mock.calls
      .map((c: any) => c[0].data)
      .find((d: any) => d.productId === "variant-1")!;
    expect(variantMovement.avgCostAfter.toString()).toBe("9.99");
    // The lot/movement unitCost itself still resolves normally (parent's average).
    expect(variantMovement.unitCost.toString()).toBe("4");
  });

  it("conserves lots: the parent's lot drawdown sums to exactly what the variant lots gain", async () => {
    prisma.product.findUnique.mockResolvedValue(parent({ currentStock: D(50) }));
    prisma.product.findFirst
      .mockResolvedValueOnce(variant({ id: "variant-1" }))
      .mockResolvedValueOnce(variant({ id: "variant-2" }));
    prisma.stockLot.findMany.mockResolvedValue([
      { id: "lot-a", remainingQty: D(10), unitCost: D(3) },
      { id: "lot-b", remainingQty: D(20), unitCost: D(5) },
    ]);

    await service.assignToVariants(
      {
        parentProductId: "parent-1",
        assignments: [
          { productId: "variant-1", qty: 6 },
          { productId: "variant-2", qty: 9 },
        ],
      } as any,
      "user-1",
    );

    const drawdown = prisma.stockLot.update.mock.calls.reduce(
      (sum: Prisma.Decimal, c: any) => sum.add(c[0].data.remainingQty.decrement),
      D(0),
    );
    const opened = prisma.stockLot.create.mock.calls.reduce(
      (sum: Prisma.Decimal, c: any) => sum.add(c[0].data.qty),
      D(0),
    );
    expect(drawdown.toString()).toBe("15");
    expect(opened.toString()).toBe("15");
    expect(drawdown.toString()).toBe(opened.toString());
  });

  it("creates a new variant inline that inherits the parent's price tiers, category, unitsPerBox, costing, and regulated fields", async () => {
    prisma.product.findUnique.mockResolvedValue(
      parent({
        currentStock: D(20),
        category: "Beverages",
        unitsPerBox: 12,
        costingMethod: "AVCO",
        trackedCategoryId: "cat-1",
        regUomUnit: "EA",
      }),
    );
    prisma.product.findFirst.mockResolvedValue(null); // no name collision
    prisma.product.create.mockResolvedValue(
      variant({
        id: "new-variant-1",
        variantName: "Zero",
        costingMethod: "AVCO",
        currentStock: D(0),
      }),
    );

    const result = await service.assignToVariants(
      {
        parentProductId: "parent-1",
        assignments: [{ newVariant: { name: "Zero" }, qty: 4 }],
      } as any,
      "user-1",
    );

    expect(prisma.product.create).toHaveBeenCalledTimes(1);
    const createData = prisma.product.create.mock.calls[0][0].data;
    expect(createData.parentProductId).toBe("parent-1");
    expect(createData.variantName).toBe("Zero");
    expect(createData.name).toBe("Cola 24pk - Zero");
    expect(createData.category).toBe("Beverages");
    expect(createData.unitsPerBox).toBe(12);
    expect(createData.costingMethod).toBe("AVCO");
    expect(createData.trackedCategoryId).toBe("cat-1");
    expect(createData.regUomUnit).toBe("EA");

    expect(result.assignments[0].created).toBe(true);
    expect(result.assignments[0].productId).toBe("new-variant-1");
  });

  it("costs a STANDARD-costed parent from its standardCost, never $0, when averageCost is null", async () => {
    // recordPurchase never writes averageCost for a STANDARD product, so this
    // is the NORMAL state of a STANDARD generic — not an edge case.
    prisma.product.findUnique.mockResolvedValue(
      parent({
        currentStock: D(20),
        costingMethod: "STANDARD",
        standardCost: D(5),
        averageCost: null,
      }),
    );
    prisma.product.findFirst.mockResolvedValue(variant({ costingMethod: "AVCO" }));

    const result = await service.assignToVariants(
      { parentProductId: "parent-1", assignments: [{ productId: "variant-1", qty: 10 }] } as any,
      "user-1",
    );

    expect(result.assignments[0].unitCost).toBe(5);
    const variantUpdate = prisma.product.update.mock.calls.find(
      (c: any) => c[0].where.id === "variant-1",
    )!;
    expect(variantUpdate[0].data.averageCost.toString()).toBe("5");
  });

  it("leaves the variant's averageCost untouched when no cost is known anywhere", async () => {
    prisma.product.findUnique.mockResolvedValue(
      parent({ currentStock: D(20), averageCost: null, standardCost: null }),
    );
    prisma.product.findFirst.mockResolvedValue(variant());

    await service.assignToVariants(
      { parentProductId: "parent-1", assignments: [{ productId: "variant-1", qty: 10 }] } as any,
      "user-1",
    );

    const variantUpdate = prisma.product.update.mock.calls.find(
      (c: any) => c[0].where.id === "variant-1",
    )!;
    // A fabricated 0 would read as a real "$0 cost" in getValuation and drop
    // the variant off the "no cost set" report.
    expect(variantUpdate[0].data.averageCost).toBeUndefined();
  });

  it("only accepts an ACTIVE child as a target", async () => {
    prisma.product.findUnique.mockResolvedValue(parent({ currentStock: D(20) }));
    prisma.product.findFirst.mockResolvedValue(null);

    const err = await service
      .assignToVariants(
        { parentProductId: "parent-1", assignments: [{ productId: "variant-1", qty: 5 }] } as any,
        "user-1",
      )
      .catch((e) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect(prisma.product.findFirst.mock.calls[0][0].where).toMatchObject({
      id: "variant-1",
      parentProductId: "parent-1",
      isActive: true,
    });
  });

  it("rejects the same variant twice rather than costing both rows off one stale snapshot", async () => {
    prisma.product.findUnique.mockResolvedValue(parent({ currentStock: D(20) }));
    prisma.product.findFirst.mockResolvedValue(variant());

    const err = await service
      .assignToVariants(
        {
          parentProductId: "parent-1",
          assignments: [
            { productId: "variant-1", qty: 3 },
            { productId: "variant-1", qty: 4 },
          ],
        } as any,
        "user-1",
      )
      .catch((e) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect(prisma.stockMovement.create).not.toHaveBeenCalled();
    expect(prisma.product.update).not.toHaveBeenCalled();
  });

  it("rejects boxes/pieces for a parent that is not sold in boxes instead of dropping the row", async () => {
    prisma.product.findUnique.mockResolvedValue(parent({ currentStock: D(20), unitsPerBox: null }));

    const err = await service
      .assignToVariants(
        { parentProductId: "parent-1", assignments: [{ productId: "variant-1", boxes: 2 }] } as any,
        "user-1",
      )
      .catch((e) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect(prisma.stockMovement.create).not.toHaveBeenCalled();
  });

  it("opens variant lots only for the quantity the parent's lots actually covered", async () => {
    // Opening stock imported straight onto currentStock leaves the generic
    // with fewer open lot units than stock — the uncovered share must not be
    // re-lotted onto the variants.
    prisma.product.findUnique.mockResolvedValue(parent({ currentStock: D(50) }));
    prisma.product.findFirst
      .mockResolvedValueOnce(variant({ id: "variant-1" }))
      .mockResolvedValueOnce(variant({ id: "variant-2" }));
    prisma.stockLot.findMany.mockResolvedValue([
      { id: "lot-a", remainingQty: D(10), unitCost: D(3) },
    ]);

    await service.assignToVariants(
      {
        parentProductId: "parent-1",
        assignments: [
          { productId: "variant-1", qty: 20 },
          { productId: "variant-2", qty: 10 },
        ],
      } as any,
      "user-1",
    );

    const drawdown = prisma.stockLot.update.mock.calls.reduce(
      (sum: Prisma.Decimal, c: any) => sum.add(c[0].data.remainingQty.decrement),
      D(0),
    );
    const opened = prisma.stockLot.create.mock.calls.reduce(
      (sum: Prisma.Decimal, c: any) => sum.add(c[0].data.qty),
      D(0),
    );
    expect(drawdown.toString()).toBe("10");
    expect(opened.toString()).toBe("10");
  });
});
