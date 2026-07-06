import { Test, TestingModule } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { InventoryService } from "./inventory.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";

const D = (n: number | string) => new Prisma.Decimal(n);

const product = (overrides: Record<string, unknown> = {}) => ({
  id: "prod-1",
  name: "Flour 25lb",
  currentStock: D(10),
  averageCost: D(2),
  standardCost: null,
  costingMethod: "AVCO",
  isActive: true,
  ...overrides,
});

describe("InventoryService", () => {
  let service: InventoryService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();

    const module: TestingModule = await Test.createTestingModule({
      providers: [InventoryService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get<InventoryService>(InventoryService);
  });

  // ─── recordPurchase ─────────────────────────────────────────────────────────

  describe("recordPurchase", () => {
    it("writes the movement with unitCost + snapshots and updates the weighted average", async () => {
      prisma.product.findUnique.mockResolvedValue(product());
      prisma.stockMovement.count.mockResolvedValue(0);

      await service.recordPurchase(
        { productId: "prod-1", quantity: 5, unitCost: 3.5 } as any,
        "user-1",
      );

      // Movement carries unitCost and post-movement snapshots
      const movementArgs = prisma.stockMovement.create.mock.calls[0][0].data;
      expect(movementArgs.type).toBe("PURCHASE");
      expect(movementArgs.unitCost.toString()).toBe("3.5");
      // (10×2 + 5×3.5) / 15 = 2.5
      expect(movementArgs.avgCostAfter.toString()).toBe("2.5");
      expect(movementArgs.stockAfter.toString()).toBe("15");

      // StockLot created for lot tracking
      const lotArgs = prisma.stockLot.create.mock.calls[0][0].data;
      expect(lotArgs.qty.toString()).toBe("5");
      expect(lotArgs.remainingQty.toString()).toBe("5");
      expect(lotArgs.unitCost.toString()).toBe("3.5");

      // Product average updated
      const productArgs = prisma.product.update.mock.calls[0][0].data;
      expect(productArgs.averageCost.toString()).toBe("2.5");
    });

    it("resets the average to the incoming cost when stock is zero", async () => {
      prisma.product.findUnique.mockResolvedValue(product({ currentStock: D(0) }));
      prisma.stockMovement.count.mockResolvedValue(0);

      await service.recordPurchase(
        { productId: "prod-1", quantity: 10, unitCost: 4.25 } as any,
        "user-1",
      );

      const productArgs = prisma.product.update.mock.calls[0][0].data;
      expect(productArgs.averageCost.toString()).toBe("4.25");
    });

    it("does not touch averageCost for STANDARD-cost products", async () => {
      prisma.product.findUnique.mockResolvedValue(
        product({ costingMethod: "STANDARD", standardCost: D(2.1) }),
      );
      prisma.stockMovement.count.mockResolvedValue(0);

      await service.recordPurchase(
        { productId: "prod-1", quantity: 5, unitCost: 3.5 } as any,
        "user-1",
      );

      const productArgs = prisma.product.update.mock.calls[0][0].data;
      expect(productArgs.averageCost).toBeUndefined();
      // Snapshot carries the UNCHANGED average forward
      const movementArgs = prisma.stockMovement.create.mock.calls[0][0].data;
      expect(movementArgs.avgCostAfter.toString()).toBe("2");
    });
  });

  // ─── recordSale ─────────────────────────────────────────────────────────────

  describe("recordSale", () => {
    const tx = () => prisma as any;

    it("writes the SALE movement with the average cost for AVCO products", async () => {
      prisma.product.findUnique.mockResolvedValue(product());

      const result = await service.recordSale("prod-1", D(4), "ORD-1", "user-1", tx());

      const movementArgs = prisma.stockMovement.create.mock.calls[0][0].data;
      expect(movementArgs.type).toBe("SALE");
      expect(movementArgs.quantity.toString()).toBe("-4");
      expect(movementArgs.unitCost.toString()).toBe("2");
      expect(movementArgs.avgCostAfter.toString()).toBe("2");
      expect(movementArgs.stockAfter.toString()).toBe("6");
      expect(result.unitCost.toString()).toBe("2");
      expect(result.stockAfter.toString()).toBe("6");
    });

    it("blends consumed lot costs for FIFO products and draws the lots down", async () => {
      prisma.product.findUnique.mockResolvedValue(product({ costingMethod: "FIFO" }));
      prisma.stockLot.findMany.mockResolvedValue([
        { id: "lot-1", remainingQty: D(5), unitCost: D(1) },
        { id: "lot-2", remainingQty: D(10), unitCost: D(2) },
      ]);

      const result = await service.recordSale("prod-1", D(8), null, null, tx());

      // (5×1 + 3×2) / 8 = 1.375
      expect(result.unitCost.toString()).toBe("1.375");
      expect(prisma.stockLot.update).toHaveBeenCalledTimes(2);
      expect(prisma.stockLot.update.mock.calls[0][0]).toEqual({
        where: { id: "lot-1" },
        data: { remainingQty: { decrement: D(5) } },
      });
      expect(prisma.stockLot.update.mock.calls[1][0]).toEqual({
        where: { id: "lot-2" },
        data: { remainingQty: { decrement: D(3) } },
      });
    });

    it("falls back to the average cost when FIFO lots are missing (pre-fix data)", async () => {
      prisma.product.findUnique.mockResolvedValue(product({ costingMethod: "FIFO" }));
      prisma.stockLot.findMany.mockResolvedValue([]);

      const result = await service.recordSale("prod-1", D(4), null, null, tx());

      expect(result.unitCost.toString()).toBe("2");
      expect(prisma.stockLot.update).not.toHaveBeenCalled();
    });

    it("uses standardCost for STANDARD products", async () => {
      prisma.product.findUnique.mockResolvedValue(
        product({ costingMethod: "STANDARD", standardCost: D(2.75) }),
      );

      const result = await service.recordSale("prod-1", D(2), null, null, tx());

      expect(result.unitCost.toString()).toBe("2.75");
    });

    it("uses the most recent purchase lot's cost for LAST_COST products", async () => {
      prisma.product.findUnique.mockResolvedValue(product({ costingMethod: "LAST_COST" }));
      prisma.stockLot.findFirst.mockResolvedValue({ unitCost: D(3.5) });

      const result = await service.recordSale("prod-1", D(2), null, null, tx());

      expect(prisma.stockLot.findFirst).toHaveBeenCalledWith({
        where: { productId: "prod-1" },
        orderBy: { purchaseDate: "desc" },
        select: { unitCost: true },
      });
      expect(result.unitCost.toString()).toBe("3.5");
      // Last cost is not lot-consuming.
      expect(prisma.stockLot.update).not.toHaveBeenCalled();
    });

    it("falls back to the average cost for LAST_COST when there are no lots", async () => {
      prisma.product.findUnique.mockResolvedValue(product({ costingMethod: "LAST_COST" }));
      prisma.stockLot.findFirst.mockResolvedValue(null);

      const result = await service.recordSale("prod-1", D(2), null, null, tx());

      expect(result.unitCost.toString()).toBe("2"); // averageCost fallback
    });

    it("never throws when stock goes negative", async () => {
      prisma.product.findUnique.mockResolvedValue(product({ currentStock: D(1) }));

      const result = await service.recordSale("prod-1", D(5), null, null, tx());

      expect(result.stockAfter.toString()).toBe("-4");
      expect(prisma.product.update).toHaveBeenCalledWith({
        where: { id: "prod-1" },
        data: { currentStock: { decrement: D(5) } },
      });
    });
  });

  // ─── setCostBasis ───────────────────────────────────────────────────────────

  describe("setCostBasis", () => {
    it("creates a COST_BASIS movement (qty 0) and updates the product average", async () => {
      prisma.product.findUnique.mockResolvedValue(product({ averageCost: null }));

      await service.setCostBasis("prod-1", { unitCost: 3.15, notes: "opening basis" }, "user-1");

      const movementArgs = prisma.stockMovement.create.mock.calls[0][0].data;
      expect(movementArgs.type).toBe("COST_BASIS");
      expect(movementArgs.quantity).toBe(0);
      expect(movementArgs.unitCost.toString()).toBe("3.15");
      expect(movementArgs.avgCostAfter.toString()).toBe("3.15");
      expect(movementArgs.stockAfter.toString()).toBe("10");
      expect(movementArgs.performedById).toBe("user-1");

      expect(prisma.product.update).toHaveBeenCalledWith({
        where: { id: "prod-1" },
        data: { averageCost: D(3.15) },
      });
      // Lots untouched unless explicitly requested
      expect(prisma.stockLot.updateMany).not.toHaveBeenCalled();
    });

    it("rewrites open lots only when applyToLots is set", async () => {
      prisma.product.findUnique.mockResolvedValue(product());

      await service.setCostBasis("prod-1", { unitCost: 3, applyToLots: true }, "user-1");

      expect(prisma.stockLot.updateMany).toHaveBeenCalledWith({
        where: { productId: "prod-1", remainingQty: { gt: 0 } },
        data: { unitCost: D(3) },
      });
    });

    it("throws NotFound for an unknown product", async () => {
      prisma.product.findUnique.mockResolvedValue(null);

      await expect(service.setCostBasis("nope", { unitCost: 1 }, "user-1")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("bulkSetCostBasis", () => {
    it("sets each product's basis and reports the movement ids", async () => {
      prisma.product.findMany.mockResolvedValue([
        product(),
        product({ id: "prod-2", name: "Sugar" }),
      ]);
      prisma.stockMovement.create
        .mockResolvedValueOnce({ id: "mv-1" })
        .mockResolvedValueOnce({ id: "mv-2" });

      const result = await service.bulkSetCostBasis(
        {
          items: [
            { productId: "prod-1", unitCost: 2.5 },
            { productId: "prod-2", unitCost: 1.75 },
          ],
        },
        "user-1",
      );

      expect(result).toEqual({ updated: 2, movementIds: ["mv-1", "mv-2"] });
      expect(prisma.product.update).toHaveBeenCalledTimes(2);
    });

    it("throws NotFound listing the missing products", async () => {
      prisma.product.findMany.mockResolvedValue([product()]);

      await expect(
        service.bulkSetCostBasis(
          {
            items: [
              { productId: "prod-1", unitCost: 2 },
              { productId: "ghost", unitCost: 3 },
            ],
          },
          "user-1",
        ),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.stockMovement.create).not.toHaveBeenCalled();
    });
  });

  // ─── recomputeCosts ─────────────────────────────────────────────────────────

  describe("recomputeCosts", () => {
    it("replays purchase→sale→purchase into the correct final average and backfills snapshots", async () => {
      prisma.product.findMany.mockResolvedValue([product({ averageCost: D(9.99) })]);
      prisma.stockMovement.findMany.mockResolvedValue([
        { id: "m1", type: "PURCHASE", quantity: D(10), unitCost: D(2) },
        { id: "m2", type: "SALE", quantity: D(-5), unitCost: null },
        { id: "m3", type: "PURCHASE", quantity: D(5), unitCost: D(3.5) },
      ]);

      const result = await service.recomputeCosts({});

      // After m3: (5×2 + 5×3.5) / 10 = 2.75
      expect(result.updated).toBe(1);
      expect(result.noHistory).toEqual([]);
      expect(result.results[0]).toMatchObject({
        productId: "prod-1",
        oldAvgCost: 9.99,
        newAvgCost: 2.75,
        stockDrift: 0,
        movementsBackfilled: 3,
      });

      // Every movement got its snapshots backfilled
      expect(prisma.stockMovement.update).toHaveBeenCalledTimes(3);
      const saleBackfill = prisma.stockMovement.update.mock.calls[1][0];
      expect(saleBackfill.where).toEqual({ id: "m2" });
      expect(saleBackfill.data.avgCostAfter.toString()).toBe("2");
      expect(saleBackfill.data.stockAfter.toString()).toBe("5");

      // Product average rewritten to the replayed value
      expect(prisma.product.update).toHaveBeenCalledWith({
        where: { id: "prod-1" },
        data: { averageCost: D(2.75) },
      });
    });

    it("reports products with no costful history and leaves their average untouched", async () => {
      prisma.product.findMany.mockResolvedValue([product({ averageCost: null })]);
      prisma.stockMovement.findMany.mockResolvedValue([
        { id: "m1", type: "SALE", quantity: D(-2), unitCost: null },
        { id: "m2", type: "ADJUSTMENT", quantity: D(4), unitCost: null },
      ]);

      const result = await service.recomputeCosts({});

      expect(result.updated).toBe(0);
      expect(result.noHistory).toEqual([{ productId: "prod-1", name: "Flour 25lb" }]);
      expect(prisma.product.update).not.toHaveBeenCalled();
    });

    it("performs zero writes on a dry run but still reports the outcome", async () => {
      prisma.product.findMany.mockResolvedValue([product()]);
      prisma.stockMovement.findMany.mockResolvedValue([
        { id: "m1", type: "PURCHASE", quantity: D(10), unitCost: D(2) },
      ]);

      const result = await service.recomputeCosts({ dryRun: true });

      expect(result.dryRun).toBe(true);
      expect(result.results[0].newAvgCost).toBe(2);
      expect(prisma.stockMovement.update).not.toHaveBeenCalled();
      expect(prisma.product.update).not.toHaveBeenCalled();
    });

    it("reports stock drift between currentStock and replayed movements", async () => {
      // currentStock 10 but movements only account for 6 → drift 4 (imported opening stock)
      prisma.product.findMany.mockResolvedValue([product()]);
      prisma.stockMovement.findMany.mockResolvedValue([
        { id: "m1", type: "PURCHASE", quantity: D(6), unitCost: D(2) },
      ]);

      const result = await service.recomputeCosts({ dryRun: true });

      expect(result.results[0].stockDrift).toBe(4);
    });
  });

  // ─── getValuation ───────────────────────────────────────────────────────────

  describe("getValuation", () => {
    it("totals stock × effective cost and lists products missing a cost", async () => {
      prisma.product.findMany.mockResolvedValue([
        product(), // 10 × 2 = 20
        product({ id: "prod-2", name: "No-cost", averageCost: null, currentStock: D(5) }),
        product({
          id: "prod-3",
          name: "Std",
          costingMethod: "STANDARD",
          standardCost: D(1.5),
          averageCost: null,
          currentStock: D(4),
        }), // 4 × 1.5 = 6
      ]);

      const result = await service.getValuation();

      expect(result.totalValue).toBe(26);
      expect(result.productCount).toBe(3);
      expect(result.missingCostCount).toBe(1);
      expect(result.missingCostProducts).toEqual([{ id: "prod-2", name: "No-cost" }]);
    });
  });
});
