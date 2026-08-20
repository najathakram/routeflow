import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { InventoryService } from "./inventory.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { StockAlertService } from "../stock-alerts/stock-alert.service";

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
  let stockAlerts: { fireForProducts: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    stockAlerts = { fireForProducts: jest.fn().mockResolvedValue({ notified: 0 }) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InventoryService,
        { provide: PrismaService, useValue: prisma },
        { provide: StockAlertService, useValue: stockAlerts },
      ],
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

    // ─── P5-03: stock-alert fire hook ─────────────────────────────────────────

    it("fires stock alerts for the product after the tx commits", async () => {
      prisma.product.findUnique.mockResolvedValue(product());
      prisma.stockMovement.count.mockResolvedValue(0);

      await service.recordPurchase(
        { productId: "prod-1", quantity: 5, unitCost: 3.5 } as any,
        "user-1",
      );

      expect(stockAlerts.fireForProducts).toHaveBeenCalledWith(["prod-1"]);
    });

    it("still resolves the inventory write when the stock-alert fire rejects", async () => {
      prisma.product.findUnique.mockResolvedValue(product());
      prisma.stockMovement.count.mockResolvedValue(0);
      stockAlerts.fireForProducts.mockRejectedValue(new Error("push provider down"));

      await expect(
        service.recordPurchase(
          { productId: "prod-1", quantity: 5, unitCost: 3.5 } as any,
          "user-1",
        ),
      ).resolves.toBeDefined();
    });
  });

  // ─── recordAdjustment — P5-03 stock-alert fire hook ────────────────────────────

  describe("recordAdjustment", () => {
    it("fires stock alerts on a positive adjustment", async () => {
      prisma.product.findUnique.mockResolvedValue(product());
      prisma.stockMovement.count.mockResolvedValue(0);

      await service.recordAdjustment({ productId: "prod-1", quantity: 5 } as any, "user-1");

      expect(stockAlerts.fireForProducts).toHaveBeenCalledWith(["prod-1"]);
    });

    it("does NOT fire stock alerts on a negative adjustment", async () => {
      prisma.product.findUnique.mockResolvedValue(product());
      prisma.stockMovement.count.mockResolvedValue(0);

      await service.recordAdjustment({ productId: "prod-1", quantity: -3 } as any, "user-1");

      expect(stockAlerts.fireForProducts).not.toHaveBeenCalled();
    });
  });

  // ─── receivePurchaseOrder — B11: STANDARD cost guard ───────────────────────

  const purchaseOrder = (overrides: Record<string, unknown> = {}) => ({
    id: "po-1",
    poNumber: "PO-1001",
    supplierId: "sup-1",
    status: "SENT",
    items: [
      {
        id: "poi-1",
        productId: "prod-1",
        qtyOrdered: D(10),
        qtyReceived: D(0),
        unitCost: D(3.5),
      },
    ],
    ...overrides,
  });

  describe("receivePurchaseOrder", () => {
    it("B11: a STANDARD product keeps its cost — averageCost untouched on receive", async () => {
      prisma.purchaseOrder.findUnique.mockResolvedValue(purchaseOrder());
      prisma.product.findUnique.mockResolvedValue(
        product({ costingMethod: "STANDARD", currentStock: D(10), averageCost: D(2) }),
      );

      await service.receivePurchaseOrder(
        "po-1",
        { items: [{ itemId: "poi-1", receivedQty: 5 }] },
        "user-1",
      );

      const productArgs = prisma.product.update.mock.calls[0][0].data;
      expect(productArgs.averageCost).toBeUndefined();
      expect(productArgs.currentStock.toString()).toBe("15");
      // Movement snapshot carries the UNCHANGED average forward, not the
      // would-be weighted average.
      const movementArgs = prisma.stockMovement.create.mock.calls[0][0].data;
      expect(movementArgs.avgCostAfter.toString()).toBe("2");
    });

    it("B11: an AVCO product still updates its weighted average on receive", async () => {
      prisma.purchaseOrder.findUnique.mockResolvedValue(purchaseOrder());
      prisma.product.findUnique.mockResolvedValue(
        product({ costingMethod: "AVCO", currentStock: D(10), averageCost: D(2) }),
      );

      await service.receivePurchaseOrder(
        "po-1",
        { items: [{ itemId: "poi-1", receivedQty: 5 }] },
        "user-1",
      );

      // (10×2 + 5×3.5) / 15 = 2.5
      const productArgs = prisma.product.update.mock.calls[0][0].data;
      expect(productArgs.averageCost.toString()).toBe("2.5");
      const movementArgs = prisma.stockMovement.create.mock.calls[0][0].data;
      expect(movementArgs.avgCostAfter.toString()).toBe("2.5");
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

    it("uses the most recent PURCHASE movement's cost for LAST_COST products", async () => {
      prisma.product.findUnique.mockResolvedValue(product({ costingMethod: "LAST_COST" }));
      // A newest bill @ 3.5; a later positive stock-count lot @ avg cost must NOT win.
      prisma.stockMovement.findFirst.mockResolvedValue({ unitCost: D(3.5) });

      const result = await service.recordSale("prod-1", D(2), null, null, tx());

      // Purchase-only + deterministic ordering (createdAt, then id).
      expect(prisma.stockMovement.findFirst).toHaveBeenCalledWith({
        where: { productId: "prod-1", type: "PURCHASE" },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { unitCost: true },
      });
      expect(result.unitCost.toString()).toBe("3.5");
      // Last cost is not lot-consuming.
      expect(prisma.stockLot.update).not.toHaveBeenCalled();
    });

    it("falls back to the average cost for LAST_COST when there are no purchases", async () => {
      prisma.product.findUnique.mockResolvedValue(product({ costingMethod: "LAST_COST" }));
      prisma.stockMovement.findFirst.mockResolvedValue(null);

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

    it("values a FIFO-labelled product at the weighted average, ignoring stock lots", async () => {
      // Lots are never drawn down (recordSale has no caller), so a lot set that
      // outlives the stock it describes must not inflate the carrying value:
      // 10 units at avg 2 = 20, regardless of a stale 40-unit lot at cost 3.
      prisma.product.findMany.mockResolvedValue([
        product({ costingMethod: "FIFO", currentStock: D(10), averageCost: D(2) }),
      ]);
      prisma.stockLot.findMany.mockResolvedValue([
        { productId: "prod-1", remainingQty: D(40), unitCost: D(3) },
      ]);

      const result = await service.getValuation();

      expect(result.totalValue).toBe(20);
      expect(result.missingCostCount).toBe(0);
      expect(prisma.stockLot.findMany).not.toHaveBeenCalled();
    });

    it("values a product with zero stock at zero however many lots survive", async () => {
      prisma.product.findMany.mockResolvedValue([
        product({ costingMethod: "FIFO", currentStock: D(0), averageCost: D(5) }),
      ]);
      prisma.stockLot.findMany.mockResolvedValue([
        { productId: "prod-1", remainingQty: D(7), unitCost: D(5) },
      ]);

      const result = await service.getValuation();

      expect(result.totalValue).toBe(0);
    });
  });

  // ─── getStockOverview ─────────────────────────────────────────────────────────

  describe("getStockOverview", () => {
    it("reports a FIFO row at the weighted average so it reconciles with getValuation", async () => {
      prisma.product.findMany.mockResolvedValue([
        product({ costingMethod: "FIFO", currentStock: D(10), averageCost: D(2) }),
      ]);
      prisma.stockLot.findMany.mockResolvedValue([
        { productId: "prod-1", remainingQty: D(40), unitCost: D(3) },
      ]);

      const [row] = await service.getStockOverview();

      expect(row.totalValue).toBe(20);
      expect(row.averageCost).toBe(2);
      expect(prisma.stockLot.findMany).not.toHaveBeenCalled();
    });

    it("selects trackedCategoryId and passes it through to the row (regulated-section filtering)", async () => {
      prisma.product.findMany.mockResolvedValue([product({ trackedCategoryId: "sec-1" })]);

      const [row] = await service.getStockOverview();

      expect(prisma.product.findMany.mock.calls[0][0].select).toMatchObject({
        trackedCategoryId: true,
      });
      expect(row.trackedCategoryId).toBe("sec-1");
    });
  });

  // ─── commitStockCount — idempotency ───────────────────────────────────────────

  describe("commitStockCount idempotency", () => {
    it("short-circuits a re-posted session instead of double-applying its deltas", async () => {
      prisma.product.findMany.mockResolvedValue([product()]);
      // A prior commit for this session already wrote movements (its response was lost).
      prisma.stockMovement.findMany.mockResolvedValue([{ id: "existing-1" }, { id: "existing-2" }]);

      const result = await service.commitStockCount(
        {
          sessionId: "11111111-1111-1111-1111-111111111111",
          items: [{ productId: "prod-1", quantity: 5, mode: "ADD" }],
        } as any,
        "user-1",
      );

      expect(result).toMatchObject({ applied: 2, skipped: 0, alreadyCommitted: true });
      expect(prisma.stockMovement.create).not.toHaveBeenCalled();
      expect(prisma.product.update).not.toHaveBeenCalled();
    });
  });

  // ─── PR-C: durable stock-count sessions ──────────────────────────────────────

  describe("stock-count sessions", () => {
    const line = (over: Record<string, unknown> = {}) => ({
      id: "line-1",
      sessionId: "sess-1",
      productId: "prod-1",
      mode: "REPLACE",
      countedQty: D(7),
      boxes: null,
      pieces: null,
      expectedQty: D(10),
      unitCostOverride: null,
      countedById: "user-1",
      ...over,
    });
    const session = (over: Record<string, unknown> = {}) => ({
      id: "sess-1",
      status: "OPEN",
      movementReference: null,
      lines: [line()],
      ...over,
    });

    it("a committed session short-circuits instead of re-applying its deltas", async () => {
      prisma.stockCountSession.findUnique.mockResolvedValue(
        session({ status: "COMMITTED", movementReference: "STOCK_COUNT-sess-1" }),
      );

      const res = await service.commitStockCountSession("sess-1", {}, { sub: "user-1" });

      expect(res).toMatchObject({ alreadyCommitted: true, applied: 0 });
      expect(prisma.stockMovement.create).not.toHaveBeenCalled();
      expect(prisma.product.update).not.toHaveBeenCalled();
    });

    it("existing movements for the reference short-circuit a lost-response retry", async () => {
      prisma.stockCountSession.findUnique.mockResolvedValue(session());
      prisma.product.findMany.mockResolvedValue([product()]);
      prisma.stockMovement.findMany.mockResolvedValue([{ id: "m-existing" }]);

      const res = await service.commitStockCountSession("sess-1", {}, { sub: "user-1" });

      expect(res).toMatchObject({ alreadyCommitted: true, applied: 1 });
      expect(prisma.stockMovement.create).not.toHaveBeenCalled();
    });

    it("REPLACE commits the counted-minus-expected delta and never touches uncounted products", async () => {
      prisma.stockCountSession.findUnique.mockResolvedValue(session());
      prisma.product.findMany.mockResolvedValue([product()]); // currentStock 10
      prisma.stockMovement.findMany.mockResolvedValue([]);
      prisma.product.findUnique.mockResolvedValue(product());

      await service.commitStockCountSession("sess-1", {}, { sub: "user-1" });

      // Counted 7 against on-hand 10 ⇒ a −3 ADJUSTMENT, not an absolute write.
      expect(prisma.stockMovement.create).toHaveBeenCalledTimes(1);
      const mv = prisma.stockMovement.create.mock.calls[0][0].data;
      expect(mv.type).toBe("ADJUSTMENT");
      expect(Number(mv.quantity)).toBe(-3);
      expect(mv.reference).toBe("STOCK_COUNT-sess-1");
      // Only the counted product is updated — a count asserts only what it saw.
      expect(prisma.product.update).toHaveBeenCalledTimes(1);
      expect(prisma.product.update.mock.calls[0][0].where).toEqual({ id: "prod-1" });
    });

    it("a zero-variance line is skipped, writing no movement at all", async () => {
      prisma.stockCountSession.findUnique.mockResolvedValue(
        session({ lines: [line({ countedQty: D(10) })] }), // equals on-hand
      );
      prisma.product.findMany.mockResolvedValue([product()]);
      prisma.stockMovement.findMany.mockResolvedValue([]);

      const res = await service.commitStockCountSession("sess-1", {}, { sub: "user-1" });

      expect(res.applied).toBe(0);
      expect(res.skipped).toBe(1);
      expect(prisma.stockMovement.create).not.toHaveBeenCalled();
    });

    it("a unitCostOverride writes COST_BASIS BEFORE the adjustment, so the lot is valued at the corrected cost", async () => {
      prisma.stockCountSession.findUnique.mockResolvedValue(
        // Counted 15 vs on-hand 10 ⇒ +5, so a lot is opened.
        session({ lines: [line({ countedQty: D(15), unitCostOverride: D(3.5) })] }),
      );
      prisma.product.findMany.mockResolvedValue([product()]); // averageCost 2
      prisma.stockMovement.findMany.mockResolvedValue([]);
      // After the COST_BASIS write the product re-reads at the corrected cost.
      prisma.product.findUnique.mockResolvedValue(product({ averageCost: D(3.5) }));
      prisma.stockMovement.create.mockImplementation((args: any) =>
        Promise.resolve({ id: `mv-${args.data.type}` }),
      );

      const res = await service.commitStockCountSession("sess-1", {}, { sub: "user-1" });

      const types = prisma.stockMovement.create.mock.calls.map((c: any) => c[0].data.type);
      expect(types).toEqual(["COST_BASIS", "ADJUSTMENT"]); // order is load-bearing
      expect(res.costMovementIds).toHaveLength(1);
      // The lot opened for the +5 must use the CORRECTED 3.5, not the stale 2.
      const lot = prisma.stockLot.create.mock.calls[0][0].data;
      expect(Number(lot.qty)).toBe(5);
      expect(Number(lot.unitCost)).toBe(3.5);
    });

    it("refuses to commit an empty count and a discarded one", async () => {
      prisma.stockCountSession.findUnique.mockResolvedValue(session({ lines: [] }));
      await expect(
        service.commitStockCountSession("sess-1", {}, { sub: "user-1" }),
      ).rejects.toBeInstanceOf(BadRequestException);

      prisma.stockCountSession.findUnique.mockResolvedValue(session({ status: "DISCARDED" }));
      await expect(
        service.commitStockCountSession("sess-1", {}, { sub: "user-1" }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("snapshots expectedQty on FIRST count only, so later stock drift can't move the baseline", async () => {
      prisma.stockCountSession.findUnique.mockResolvedValue({ id: "sess-1", status: "OPEN" });
      prisma.product.findUnique.mockResolvedValue({
        id: "prod-1",
        currentStock: D(10),
        unitsPerBox: null,
      });
      prisma.stockCountLine.findUnique.mockResolvedValue(null); // first count

      await service.upsertStockCountLine(
        "sess-1",
        { productId: "prod-1", countedQty: 4 },
        { sub: "user-1" },
      );

      expect(Number(prisma.stockCountLine.create.mock.calls[0][0].data.expectedQty)).toBe(10);

      // Second touch updates the count but must NOT re-snapshot the expectation.
      prisma.stockCountLine.findUnique.mockResolvedValue(line({ countedQty: D(4) }));
      await service.upsertStockCountLine(
        "sess-1",
        { productId: "prod-1", countedQty: 6 },
        { sub: "user-1" },
      );
      expect(prisma.stockCountLine.update).toHaveBeenCalled();
      expect(prisma.stockCountLine.update.mock.calls[0][0].data.expectedQty).toBeUndefined();
    });

    it("increment adds to the running count; without it the value replaces", async () => {
      prisma.stockCountSession.findUnique.mockResolvedValue({ id: "sess-1", status: "OPEN" });
      prisma.product.findUnique.mockResolvedValue({
        id: "prod-1",
        currentStock: D(10),
        unitsPerBox: null,
      });
      prisma.stockCountLine.findUnique.mockResolvedValue(line({ countedQty: D(4) }));

      await service.upsertStockCountLine(
        "sess-1",
        { productId: "prod-1", countedQty: 1, increment: true },
        { sub: "user-1" },
      );
      expect(Number(prisma.stockCountLine.update.mock.calls[0][0].data.countedQty)).toBe(5);

      await service.upsertStockCountLine(
        "sess-1",
        { productId: "prod-1", countedQty: 1 },
        { sub: "user-1" },
      );
      expect(Number(prisma.stockCountLine.update.mock.calls[1][0].data.countedQty)).toBe(1);
    });

    it("recomputes qty from a boxes/pieces split instead of trusting a loose count", async () => {
      prisma.stockCountSession.findUnique.mockResolvedValue({ id: "sess-1", status: "OPEN" });
      prisma.product.findUnique.mockResolvedValue({
        id: "prod-1",
        currentStock: D(0),
        unitsPerBox: 12,
      });
      prisma.stockCountLine.findUnique.mockResolvedValue(null);

      await service.upsertStockCountLine(
        "sess-1",
        { productId: "prod-1", boxes: 2, pieces: 3 },
        { sub: "user-1" },
      );

      const data = prisma.stockCountLine.create.mock.calls[0][0].data;
      expect(Number(data.countedQty)).toBe(27); // 2*12 + 3
      expect(data.boxes).toBe(2);
      expect(data.pieces).toBe(3);
    });

    it("a committed session is not editable — it must be amended instead", async () => {
      prisma.stockCountSession.findUnique.mockResolvedValue({
        id: "sess-1",
        status: "COMMITTED",
      });

      await expect(
        service.upsertStockCountLine(
          "sess-1",
          { productId: "prod-1", countedQty: 1 },
          {
            sub: "user-1",
          },
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("amending re-snapshots expectedQty from CURRENT stock, not the old session's", async () => {
      prisma.stockCountSession.findMany.mockResolvedValue([]);
      prisma.stockCountSession.findUnique.mockResolvedValue({
        id: "old",
        status: "COMMITTED",
        lines: [line({ countedQty: D(7), expectedQty: D(10) })],
      });
      prisma.stockCountSession.create.mockResolvedValue({ id: "new-sess" });
      // Stock has since moved to 6.
      prisma.product.findMany.mockResolvedValue([{ id: "prod-1", currentStock: D(6) }]);

      await service.startStockCountSession({ amendsSessionId: "old" }, { sub: "user-1" });

      const seeded = prisma.stockCountLine.create.mock.calls[0][0].data;
      expect(Number(seeded.expectedQty)).toBe(6); // today's on-hand, not the stale 10
      expect(Number(seeded.countedQty)).toBe(7); // the prior count is pre-filled
    });

    it("the history list computes net variance $ server-side and drops the raw lines", async () => {
      prisma.stockCountSession.findMany.mockResolvedValue([
        {
          id: "sess-1",
          status: "COMMITTED",
          lines: [
            // REPLACE: counted 7 vs expected 10 ⇒ −3 @ $2 = −$6
            {
              mode: "REPLACE",
              countedQty: D(7),
              expectedQty: D(10),
              product: { averageCost: D(2) },
            },
            // ADD: +5 @ $1.50 = +$7.50
            { mode: "ADD", countedQty: D(5), expectedQty: D(0), product: { averageCost: D(1.5) } },
          ],
        },
      ]);
      prisma.stockCountSession.count.mockResolvedValue(1);

      const res = await service.listStockCountSessions({});

      expect(res.data[0].netVarianceMoney).toBe(1.5); // −6 + 7.5
      // The rows exist only to compute the number — shipping them would make
      // the list payload unbounded.
      expect((res.data[0] as Record<string, unknown>).lines).toBeUndefined();
    });

    it("an existing open session is reported as a warning, never a block", async () => {
      prisma.stockCountSession.findMany.mockResolvedValue([{ id: "other", name: "Aisle 3" }]);
      prisma.stockCountSession.create.mockResolvedValue({ id: "new-sess" });

      const res = await service.startStockCountSession({}, { sub: "user-1" });

      expect(res.id).toBe("new-sess"); // created anyway
      expect(res.otherOpenSessions).toEqual([{ id: "other", name: "Aisle 3" }]);
    });

    it("refuses to amend a session that was never committed", async () => {
      prisma.stockCountSession.findMany.mockResolvedValue([]);
      prisma.stockCountSession.findUnique.mockResolvedValue({
        id: "old",
        status: "OPEN",
        lines: [],
      });

      await expect(
        service.startStockCountSession({ amendsSessionId: "old" }, { sub: "user-1" }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ─── recomputeCosts — STANDARD costing ────────────────────────────────────────

  describe("recomputeCosts STANDARD", () => {
    it("keeps averageCost frozen for a STANDARD product (no AVCO-style overwrite)", async () => {
      prisma.product.findMany.mockResolvedValue([
        product({
          costingMethod: "STANDARD",
          averageCost: D(5),
          standardCost: D(5),
          currentStock: D(10),
        }),
      ]);
      prisma.stockMovement.findMany.mockResolvedValue([
        { id: "m1", type: "PURCHASE", quantity: D(10), unitCost: D(2) },
      ]);

      const result = await service.recomputeCosts({});

      // Product average NOT rewritten; the dry-run diff shows no bogus correction.
      expect(prisma.product.update).not.toHaveBeenCalled();
      expect(result.results[0]).toMatchObject({ oldAvgCost: 5, newAvgCost: 5 });
    });

    it("invents no cost for a STANDARD product with no cost set", async () => {
      prisma.product.findMany.mockResolvedValue([
        product({
          costingMethod: "STANDARD",
          averageCost: null,
          standardCost: null,
          currentStock: D(10),
        }),
      ]);
      prisma.stockMovement.findMany.mockResolvedValue([
        { id: "m1", type: "PURCHASE", quantity: D(10), unitCost: D(2) },
      ]);

      const result = await service.recomputeCosts({});

      expect(result.updated).toBe(0);
      expect(result.noHistory).toEqual([{ productId: "prod-1", name: "Flour 25lb" }]);
      expect(prisma.product.update).not.toHaveBeenCalled();
    });
  });

  // ─── getForecasting ─────────────────────────────────────────────────────────

  describe("getForecasting", () => {
    it("computes 30-day usage from invoiced sales, not stock movements", async () => {
      prisma.product.findMany.mockResolvedValue([
        product({ sku: "FL-25", unit: "bag", reorderPoint: 15, reorderQty: 40 }),
      ]);
      prisma.invoice.findMany.mockResolvedValue([
        {
          issueDate: new Date(),
          paidAt: null,
          items: [
            {
              productId: "prod-1",
              qty: D(45),
              subtotal: D(90),
              product: { name: "Flour 25lb", isTobacco: false },
            },
            {
              productId: "prod-1",
              qty: D(15),
              subtotal: D(30),
              product: { name: "Flour 25lb", isTobacco: false },
            },
            { productId: null, qty: D(99), subtotal: D(1), product: null }, // ad-hoc — ignored
          ],
        },
      ]);

      const [row] = await service.getForecasting();

      expect(row.totalUsed30Days).toBe(60);
      expect(row.avgDailySales).toBe(2); // 60 / 30
      expect(row.daysRemaining).toBe(5); // floor(10 / 2)
      expect(row.needsReorder).toBe(true); // stock 10 < reorderPoint 15
      // Invoiced sales windowed ~30 days on issueDate; the dead sources untouched.
      const args = prisma.invoice.findMany.mock.calls[0][0];
      expect(args.where.status).toEqual({ notIn: ["DRAFT", "VOID", "WRITTEN_OFF"] });
      const windowDays =
        (args.where.issueDate.lte.getTime() - args.where.issueDate.gte.getTime()) / 86_400_000;
      expect(Math.round(windowDays)).toBe(30);
      expect(prisma.stockMovement.findMany).not.toHaveBeenCalled();
      expect(prisma.invoiceItem.findMany).not.toHaveBeenCalled();
    });

    it("reports zero demand and null daysRemaining when nothing was invoiced", async () => {
      prisma.product.findMany.mockResolvedValue([product({ reorderPoint: null })]);

      const [row] = await service.getForecasting();

      expect(row.avgDailySales).toBe(0);
      expect(row.totalUsed30Days).toBe(0);
      expect(row.daysRemaining).toBeNull();
      expect(row.needsReorder).toBe(false);
    });
  });
});
