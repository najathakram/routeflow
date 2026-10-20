// SA-767 L-2.2: `commitStockCountSession` holds a session-scoped advisory lock (db-locks, a real pg
// connection). These specs have no database, so the lock is a PASS-THROUGH that still runs the body.
jest.mock("../common/db-locks", () => ({
  ...jest.requireActual("../common/db-locks"),
  withAdvisoryLock: async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  }),
}));

import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { InventoryService, isReplayCorrection } from "./inventory.service";
import { effectiveDateOf } from "./stock-write-date";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { AuditService } from "../audit/audit.service";
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
  let audit: { log: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    stockAlerts = { fireForProducts: jest.fn().mockResolvedValue({ notified: 0 }) };
    audit = { log: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InventoryService,
        { provide: PrismaService, useValue: prisma },
        { provide: StockAlertService, useValue: stockAlerts },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();

    service = module.get<InventoryService>(InventoryService);
  });

  // ─── recordPurchase ─────────────────────────────────────────────────────────

  describe("recordPurchase", () => {
    // B562 PR-3: the row's stockAfter is the counter the product.update RETURNED (SA-136 §1).
    const counterAfterUpdate = (n: number) =>
      prisma.product.update.mockResolvedValue({ currentStock: D(n) } as any);

    it("writes the movement with unitCost + snapshots and updates the weighted average", async () => {
      prisma.product.findUnique.mockResolvedValue(product());
      prisma.stockMovement.count.mockResolvedValue(0);
      counterAfterUpdate(15);

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

    it("B562 PR-3: stockAfter is the counter the update returned, never the pre-transaction read", async () => {
      // The pre-read says 10, but a concurrent write left 94 before this +5 landed.
      prisma.product.findUnique.mockResolvedValue(product());
      prisma.stockMovement.count.mockResolvedValue(0);
      counterAfterUpdate(99);

      await service.recordPurchase(
        { productId: "prod-1", quantity: 5, unitCost: 3.5 } as any,
        "user-1",
      );

      expect(prisma.stockMovement.create.mock.calls[0][0].data.stockAfter.toString()).toBe("99");
      expect(prisma.product.update.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.stockMovement.create.mock.invocationCallOrder[0],
      );
    });

    it("B562 PR-3: refuses a future effectiveDate (it would sort after every real row to come)", async () => {
      prisma.product.findUnique.mockResolvedValue(product());
      const tomorrow = new Date(Date.now() + 24 * 3600 * 1000).toISOString();

      await expect(
        service.recordPurchase(
          { productId: "prod-1", quantity: 5, unitCost: 3.5, effectiveDate: tomorrow } as any,
          "user-1",
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.stockMovement.create).not.toHaveBeenCalled();
    });

    it("SA-372: the future-date bound is 5 minutes of clock skew — 6 min ahead refused, 4 min accepted", () => {
      const now = new Date("2026-09-26T12:00:00.000Z");
      const at = (min: number) => new Date(now.getTime() + min * 60_000).toISOString();

      expect(() => effectiveDateOf(at(6), now)).toThrow(BadRequestException);
      expect(effectiveDateOf(at(4), now).toISOString()).toBe(at(4));
      expect(effectiveDateOf(undefined, now)).toBe(now);
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

    // ─── receiving-box-conversion (2026-08-23): boxed payloads convert ─────────

    it("converts a boxed payload (boxes×unitsPerBox) to pieces before writing stock, movement, lot and average cost", async () => {
      prisma.product.findUnique.mockResolvedValue(
        product({ unitsPerBox: 24, currentStock: D(0), averageCost: null }),
      );
      prisma.stockMovement.count.mockResolvedValue(0);
      counterAfterUpdate(120);

      await service.recordPurchase(
        { productId: "prod-1", boxes: 5, unitCost: 48 } as any,
        "user-1",
      );

      // 5 boxes × 24 units/box = 120 pieces
      const movementArgs = prisma.stockMovement.create.mock.calls[0][0].data;
      expect(Number(movementArgs.quantity)).toBe(120);
      expect(movementArgs.stockAfter.toString()).toBe("120");
      // $48/box ÷ 24 = $2/piece; stock was 0 so the average resets to it.
      expect(movementArgs.unitCost.toString()).toBe("2");
      expect(movementArgs.avgCostAfter.toString()).toBe("2");

      const lotArgs = prisma.stockLot.create.mock.calls[0][0].data;
      expect(Number(lotArgs.qty)).toBe(120);
      expect(lotArgs.unitCost.toString()).toBe("2");

      const productArgs = prisma.product.update.mock.calls[0][0].data;
      expect(productArgs.currentStock.increment.toString()).toBe("120");
      expect(productArgs.averageCost.toString()).toBe("2");
    });

    it("a bare quantity KEEPS meaning pieces even for a boxed product — never reinterpreted as boxes (regression pin)", async () => {
      prisma.product.findUnique.mockResolvedValue(
        product({ unitsPerBox: 24, currentStock: D(10), averageCost: D(2) }),
      );
      prisma.stockMovement.count.mockResolvedValue(0);
      counterAfterUpdate(130);

      await service.recordPurchase(
        { productId: "prod-1", quantity: 120, unitCost: 3.5 } as any,
        "user-1",
      );

      // No boxes/pieces sent: 120 is pieces, NOT boxes (which would resolve to
      // 120 × 24 = 2880 if this ever regressed to reinterpreting it).
      const movementArgs = prisma.stockMovement.create.mock.calls[0][0].data;
      expect(Number(movementArgs.quantity)).toBe(120);
      expect(movementArgs.stockAfter.toString()).toBe("130"); // 10 + 120
      // unitCost also stays per-piece — no ÷unitsPerBox conversion applied.
      expect(movementArgs.unitCost.toString()).toBe("3.5");

      const productArgs = prisma.product.update.mock.calls[0][0].data;
      expect(productArgs.currentStock.increment.toString()).toBe("120");
    });

    it("rejects a purchase that resolves to zero quantity (neither quantity nor boxes/pieces yields a positive total)", async () => {
      prisma.product.findUnique.mockResolvedValue(product());

      await expect(
        service.recordPurchase({ productId: "prod-1", unitCost: 3.5 } as any, "user-1"),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.stockMovement.create).not.toHaveBeenCalled();
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

    // ─── B562: a backdated write must never trigger a sales-blind replay ──────
    //
    // Real lifecycle being modelled: 20 units bought @ $1 (movement m1), then
    // 15 of them were SOLD via an order — orders decrement currentStock
    // directly and write no StockMovement (B562's mechanism) — leaving 5
    // physically on hand, then 10 more bought @ $10 (movement m2) for a true
    // post-purchase stock of 15 at a true weighted average of
    // (5×1 + 10×10)/15 = $7. `currentStock`/`averageCost` below already carry
    // that true state. The operator now backdates an unrelated adjustment to
    // before m1, which makes recordAdjustment think it must replay m1+m2 to
    // repair their snapshots. Replaying from a movement-only view (blind to
    // the 15-unit sale) recomputes stock as 20+10=30 and average as
    // (20×1+10×10)/30 = $4 — a wrong but perfectly plausible-looking number
    // that would silently clobber the correct $7 and rewrite m1/m2's
    // snapshots to match the fabricated 30-unit stock, destroying the
    // evidence needed to notice any of this afterwards.
    it("B562: refuses a backdated adjustment's replay instead of overwriting averageCost with a sales-blind figure", async () => {
      prisma.product.findUnique.mockResolvedValue(
        product({ currentStock: D(15), averageCost: D(7) }),
      );
      // Both existing purchase movements postdate the new backdated adjustment.
      prisma.stockMovement.count.mockResolvedValue(2);
      // recomputeProductInTx re-reads the product fresh inside the tx.
      prisma.product.findFirst.mockResolvedValue({
        id: "prod-1",
        name: "Flour 25lb",
        currentStock: D(15),
        averageCost: D(7),
        costingMethod: "AVCO",
      });
      // The ledger the replay actually sees — no trace of the 15-unit sale.
      prisma.stockMovement.findMany.mockResolvedValue([
        { id: "m1", type: "PURCHASE", quantity: D(20), unitCost: D(1) },
        { id: "m2", type: "PURCHASE", quantity: D(10), unitCost: D(10) },
      ]);

      await expect(
        service.recordAdjustment(
          {
            productId: "prod-1",
            quantity: -1,
            effectiveDate: "2020-01-01",
          } as any,
          "user-1",
        ),
      ).rejects.toMatchObject({
        constructor: ConflictException,
        // Operator-readable message, no internals (bug id/table/file names) —
        // the engineering detail lives in `code` for logs instead.
        response: expect.objectContaining({
          code: "INVENTORY_LEDGER_GAP",
          productId: "prod-1",
          stockDrift: -15,
        }),
      });

      // The corrupting repair must never have run: averageCost was never
      // rewritten to the sales-blind $4, and m1/m2's snapshots were never
      // touched (the audit trail survives).
      expect(prisma.product.update).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ averageCost: expect.anything() }),
        }),
      );
      expect(prisma.stockMovement.update).not.toHaveBeenCalled();
    });

    // B562 follow-up: vendor-bill receive must flag a gapped line instead of
    // aborting the whole bill (a single ONE-transaction receipt covers every
    // line — see vendor-bills.service.ts `receive()`). It calls this same
    // primitive with `{ throwOnGap: false }` and reads `.gapDetected` off the
    // return value instead of catching a thrown exception.
    it("B562: recomputeProductInTx({throwOnGap:false}) reports the gap instead of throwing, and writes nothing", async () => {
      prisma.product.findFirst.mockResolvedValue({
        id: "prod-1",
        name: "Flour 25lb",
        currentStock: D(15),
        averageCost: D(7),
        costingMethod: "AVCO",
      });
      prisma.stockMovement.findMany.mockResolvedValue([
        { id: "m1", type: "PURCHASE", quantity: D(20), unitCost: D(1) },
        { id: "m2", type: "PURCHASE", quantity: D(10), unitCost: D(10) },
      ]);

      const result = await service.recomputeProductInTx(prisma.forTenant() as any, "prod-1", {
        throwOnGap: false,
      });

      expect(result).toMatchObject({ gapDetected: true, stockDrift: -15 });
      expect(prisma.product.update).not.toHaveBeenCalled();
      expect(prisma.stockMovement.update).not.toHaveBeenCalled();
    });

    // B846: revertToDraft appends a signed PURCHASE row per receipt row. The replay must read a
    // negative PURCHASE as the exact inverse of the receipt (like the costed negative ADJUSTMENT),
    // never feed it to nextAverageCost — stock + qty = 0 divides by zero (Infinity).
    it("B846: a +10 @2 receipt and its -10 @2 bill-revert row replay to a finite average (no division by zero)", async () => {
      prisma.product.findFirst.mockResolvedValue({
        id: "prod-1",
        name: "Widget",
        currentStock: D(0),
        averageCost: D(2),
        costingMethod: "AVCO",
      });
      prisma.stockMovement.findMany.mockResolvedValue([
        { id: "m1", type: "PURCHASE", quantity: D(10), unitCost: D(2), avgCostAfter: D(2) },
        {
          id: "m2",
          type: "PURCHASE",
          quantity: D(-10),
          unitCost: D(2),
          avgCostAfter: D(2),
          notes: "BILL_REVERTED — reverses m1",
        },
      ]);

      const result = await service.recomputeProductInTx(prisma.forTenant() as any, "prod-1");

      expect(result).toMatchObject({ gapDetected: false, newAvgCost: 2 });
      expect(Number.isFinite(Number(result?.newAvgCost))).toBe(true);
    });

    it("B846: a reversal dated BEHIND a later receipt replays to the later receipt's cost (ledger order, not insertion order)", async () => {
      prisma.product.findFirst.mockResolvedValue({
        id: "prod-1",
        name: "Widget",
        currentStock: D(10),
        averageCost: D(3),
        costingMethod: "AVCO",
      });
      // Accounting order: receipt A, its backdated reversal, then receipt B.
      prisma.stockMovement.findMany.mockResolvedValue([
        { id: "a", type: "PURCHASE", quantity: D(10), unitCost: D(2), avgCostAfter: D(2) },
        { id: "ra", type: "PURCHASE", quantity: D(-10), unitCost: D(2), avgCostAfter: D(2) },
        { id: "b", type: "PURCHASE", quantity: D(10), unitCost: D(4), avgCostAfter: D(3) },
      ]);

      const result = await service.recomputeProductInTx(prisma.forTenant() as any, "prod-1");

      expect(result).toMatchObject({ gapDetected: false, newAvgCost: 4 });
    });

    // Pre-merge review gate Q1: a product imported with opening stock and NO
    // cost (products.service.ts/import.service.ts model that as a PURCHASE
    // movement with unitCost null/undefined — see their specs). The replay
    // must see that as "no costful history yet" and leave averageCost alone
    // — never write it to 0 — per the persist guard `if (!isStandard &&
    // hasCostfulHistory && avg != null)` in replayProduct.
    it("B562: a null-cost opening PURCHASE leaves averageCost untouched (never written to 0)", async () => {
      prisma.product.findFirst.mockResolvedValue({
        id: "prod-1",
        name: "Widget",
        currentStock: D(10),
        averageCost: null,
        costingMethod: "AVCO",
      });
      prisma.stockMovement.findMany.mockResolvedValue([
        { id: "m1", type: "PURCHASE", quantity: D(10), unitCost: null },
      ]);

      const result = await service.recomputeProductInTx(prisma.forTenant() as any, "prod-1");

      expect(result).toMatchObject({
        gapDetected: false,
        hasCostfulHistory: false,
        newAvgCost: null,
      });
      expect(prisma.product.update).not.toHaveBeenCalled();
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
      // Guard (d): the stock write is an atomic increment by exactly the received
      // quantity (10 on hand + 5 = 15 in the movement snapshot below), never an
      // absolute value derived from the earlier read.
      expect(productArgs.currentStock.increment.toString()).toBe("5");
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

    // ─── receiving-box-conversion (2026-08-23): boxed PO receive converts ──────

    it("converts a boxed receive item (boxes×unitsPerBox) to pieces, identically to recordPurchase", async () => {
      prisma.purchaseOrder.findUnique.mockResolvedValue(
        purchaseOrder({
          items: [
            {
              id: "poi-1",
              productId: "prod-1",
              qtyOrdered: D(200),
              qtyReceived: D(0),
              // PO line costs are stored per PIECE ($48/box ÷ 24) — the split
              // below converts the quantity only, never the cost basis.
              unitCost: D(2),
            },
          ],
        }),
      );
      prisma.product.findUnique.mockResolvedValue(
        product({ unitsPerBox: 24, currentStock: D(0), averageCost: null }),
      );

      await service.receivePurchaseOrder(
        "po-1",
        { items: [{ itemId: "poi-1", boxes: 5 }] },
        "user-1",
      );

      // 5 boxes × 24 units/box = 120 pieces
      const movementArgs = prisma.stockMovement.create.mock.calls[0][0].data;
      expect(Number(movementArgs.quantity)).toBe(120);
      expect(movementArgs.stockAfter.toString()).toBe("120");
      // The stored per-piece cost is used as-is — NOT divided again by
      // unitsPerBox just because the receive payload was boxed.
      expect(movementArgs.unitCost.toString()).toBe("2");
      expect(movementArgs.avgCostAfter.toString()).toBe("2");

      const productArgs = prisma.product.update.mock.calls[0][0].data;
      expect(productArgs.currentStock.increment.toString()).toBe("120");
      expect(productArgs.averageCost.toString()).toBe("2");

      const poItemArgs = prisma.purchaseOrderItem.update.mock.calls[0][0].data;
      expect(poItemArgs.qtyReceived).toBe(120);
    });

    it("#2734: a boxed receive uses the line's STORED pack, not the live product pack", async () => {
      prisma.purchaseOrder.findUnique.mockResolvedValue(
        purchaseOrder({
          items: [
            {
              id: "poi-1",
              productId: "prod-1",
              qtyOrdered: D(120),
              qtyReceived: D(0),
              unitCost: D(2),
              packSize: 12,
            },
          ],
        }),
      );
      // product repacked to 6 after the line was ordered at 12
      prisma.product.findUnique.mockResolvedValue(
        product({ unitsPerBox: 6, currentStock: D(0), averageCost: null }),
      );

      await service.receivePurchaseOrder(
        "po-1",
        { items: [{ itemId: "poi-1", boxes: 5 }] },
        "user-1",
      );

      // 5 boxes x stored pack 12 = 60 pieces (the live pack 6 would give 30)
      const movementArgs = prisma.stockMovement.create.mock.calls[0][0].data;
      expect(Number(movementArgs.quantity)).toBe(60);
    });

    it("a bare receivedQty KEEPS meaning pieces for a boxed product — never reinterpreted as boxes (regression pin)", async () => {
      prisma.purchaseOrder.findUnique.mockResolvedValue(purchaseOrder());
      prisma.product.findUnique.mockResolvedValue(
        product({ unitsPerBox: 24, currentStock: D(10), averageCost: D(2) }),
      );

      await service.receivePurchaseOrder(
        "po-1",
        { items: [{ itemId: "poi-1", receivedQty: 5 }] },
        "user-1",
      );

      // No boxes/pieces sent: 5 is pieces, NOT boxes.
      const movementArgs = prisma.stockMovement.create.mock.calls[0][0].data;
      expect(Number(movementArgs.quantity)).toBe(5);
      expect(movementArgs.stockAfter.toString()).toBe("15"); // 10 + 5
      // unitCost also stays per-piece — no ÷unitsPerBox conversion applied.
      expect(movementArgs.unitCost.toString()).toBe("3.5");
    });

    it("rejects a receipt bigger than what is outstanding instead of silently under-receiving", async () => {
      // A PO raised in BOXES before the cutover (qtyOrdered 10 = 10 boxes of 24)
      // receiving the 240 pieces that actually arrived: the old Math.min clamp
      // took 10 PIECES, priced them per box and flipped the PO to RECEIVED, so
      // the missing 230 could never be received.
      prisma.purchaseOrder.findUnique.mockResolvedValue(purchaseOrder());
      prisma.product.findUnique.mockResolvedValue(
        product({ unitsPerBox: 24, currentStock: D(0), averageCost: null }),
      );

      await expect(
        service.receivePurchaseOrder(
          "po-1",
          { items: [{ itemId: "poi-1", receivedQty: 240 }] },
          "user-1",
        ),
      ).rejects.toThrow(BadRequestException);

      expect(prisma.stockMovement.create).not.toHaveBeenCalled();
      expect(prisma.product.update).not.toHaveBeenCalled();
      expect(prisma.purchaseOrderItem.update).not.toHaveBeenCalled();
    });

    it("accepts the exact remaining quantity on a decimal-unit line (no float artifact)", async () => {
      // qtyOrdered/qtyReceived are Decimal(10,3): 1.2 − 0.4 is 0.7999999999999999
      // in float, so a float compare would reject the operator's correct 0.8.
      prisma.purchaseOrder.findUnique.mockResolvedValue(
        purchaseOrder({
          items: [
            {
              id: "poi-1",
              productId: "prod-1",
              qtyOrdered: D("1.2"),
              qtyReceived: D("0.4"),
              unitCost: D(3.5),
            },
          ],
        }),
      );
      prisma.product.findUnique.mockResolvedValue(
        product({ currentStock: D(0), averageCost: null }),
      );

      await service.receivePurchaseOrder(
        "po-1",
        { items: [{ itemId: "poi-1", receivedQty: 0.8 }] },
        "user-1",
      );

      const movementArgs = prisma.stockMovement.create.mock.calls[0][0].data;
      expect(movementArgs.quantity.toString()).toBe("0.8");
      expect(movementArgs.stockAfter.toString()).toBe("0.8");
    });
  });

  // ─── recordSale ─────────────────────────────────────────────────────────────

  describe("recordSale", () => {
    const tx = () => prisma as any;

    // SA-136b: stockAfter is read off the counter update's own returned row.
    const counterAfter = (n: number | string) =>
      prisma.product.update.mockResolvedValue({ currentStock: D(n) } as any);

    it("writes the SALE movement with the average cost for AVCO products", async () => {
      prisma.product.findFirst.mockResolvedValue(product());
      counterAfter(6);

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

    // SA-804 (1) / B1233: FIFO and LIFO are retired. A STORED one is costed as AVCO: the SALE unitCost is the
    // average cost (matching valuation and reports), and a sale no longer reads or draws down lots.
    it.each(["FIFO", "LIFO"])(
      "costs a stored-%s product at the AVERAGE cost, not the lot cost, and leaves the lots alone",
      async (method) => {
        prisma.product.findFirst.mockResolvedValue(product({ costingMethod: method }));
        // Lots that WOULD blend to 1.375 under the old FIFO plan; the average (2) must win.
        prisma.stockLot.findMany.mockResolvedValue([
          { id: "lot-1", remainingQty: D(5), unitCost: D(1) },
          { id: "lot-2", remainingQty: D(10), unitCost: D(2) },
        ]);
        counterAfter(2);

        const result = await service.recordSale("prod-1", D(8), null, null, tx());

        expect(result.unitCost.toString()).toBe("2");
        const movementArgs = prisma.stockMovement.create.mock.calls[0][0].data;
        expect(movementArgs.unitCost.toString()).toBe("2");
        expect(movementArgs.avgCostAfter.toString()).toBe("2");
        expect(prisma.stockLot.findMany).not.toHaveBeenCalled();
        expect(prisma.stockLot.update).not.toHaveBeenCalled();
      },
    );

    it("uses standardCost for STANDARD products", async () => {
      prisma.product.findFirst.mockResolvedValue(
        product({ costingMethod: "STANDARD", standardCost: D(2.75) }),
      );

      const result = await service.recordSale("prod-1", D(2), null, null, tx());

      expect(result.unitCost.toString()).toBe("2.75");
    });

    it("uses the most recent PURCHASE movement's cost for LAST_COST products", async () => {
      prisma.product.findFirst.mockResolvedValue(product({ costingMethod: "LAST_COST" }));
      // A newest bill @ 3.5; a later positive stock-count lot @ avg cost must NOT win.
      prisma.stockMovement.findFirst.mockResolvedValue({ unitCost: D(3.5) });

      const result = await service.recordSale("prod-1", D(2), null, null, tx());

      // Purchase-only, positive rows only (B846: a bill-revert row is negative) + deterministic
      // ordering (effectiveAt, then createdAt, then id — B562).
      expect(prisma.stockMovement.findFirst).toHaveBeenCalledWith({
        where: { productId: "prod-1", type: "PURCHASE", quantity: { gt: 0 } },
        orderBy: [{ effectiveAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
        select: { unitCost: true },
      });
      expect(result.unitCost.toString()).toBe("3.5");
      // Last cost is not lot-consuming.
      expect(prisma.stockLot.update).not.toHaveBeenCalled();
    });

    it("B846: LAST_COST excludes the receipt a bill-revert row has paired (and the reversal itself)", async () => {
      prisma.product.findFirst.mockResolvedValue(product({ costingMethod: "LAST_COST" }));
      // master asked for "the newest PURCHASE" and got the reversing row's cost (9).
      prisma.stockMovement.findFirst.mockResolvedValue({ unitCost: D(4) });
      prisma.stockMovement.findMany.mockResolvedValue([
        { notes: "BILL_REVERTED — reverses m2 (filed through September 2026)" },
      ]);

      const result = await service.recordSale("prod-1", D(2), null, null, tx());

      expect(prisma.stockMovement.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            productId: "prod-1",
            type: "PURCHASE",
            quantity: { gt: 0 },
            id: { notIn: ["m2"] },
          },
        }),
      );
      expect(result.unitCost.toString()).toBe("4");
    });

    it("falls back to the average cost for LAST_COST when there are no purchases", async () => {
      prisma.product.findFirst.mockResolvedValue(product({ costingMethod: "LAST_COST" }));
      prisma.stockMovement.findMany.mockResolvedValue([]);

      const result = await service.recordSale("prod-1", D(2), null, null, tx());

      expect(result.unitCost.toString()).toBe("2"); // averageCost fallback
    });

    it("never throws when stock goes negative", async () => {
      prisma.product.findFirst.mockResolvedValue(product({ currentStock: D(1) }));
      counterAfter(-4);

      const result = await service.recordSale("prod-1", D(5), null, null, tx());

      expect(result.stockAfter.toString()).toBe("-4");
      expect(prisma.product.update).toHaveBeenCalledWith({
        where: { id: "prod-1" },
        data: { currentStock: { decrement: D(5) } },
        select: { currentStock: true },
      });
    });

    it("SA-136b: writes the row AFTER the counter update, stockAfter from its returned row", async () => {
      // A pre-read says 10, but a concurrent writer left the counter at 3 when this decrement of
      // 4 landed: the row must carry the -1 the update returned, never 10 - 4 = 6.
      prisma.product.findFirst.mockResolvedValue(product({ currentStock: D(10) }));
      counterAfter(-1);

      const result = await service.recordSale("prod-1", D(4), "ORD-1", null, tx());

      const movementArgs = prisma.stockMovement.create.mock.calls[0][0].data;
      expect(movementArgs.stockAfter.toString()).toBe("-1");
      expect(result.stockAfter.toString()).toBe("-1");
      expect(prisma.product.update.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.stockMovement.create.mock.invocationCallOrder[0],
      );
    });
  });

  // ─── setCostBasis ───────────────────────────────────────────────────────────

  describe("setCostBasis", () => {
    it("creates a COST_BASIS movement (qty 0) and updates the product average", async () => {
      prisma.product.findUnique.mockResolvedValue(product({ averageCost: null }));
      // SA-767 L-2: the movement is stamped from the counter the update returned (the locked row).
      prisma.product.findMany.mockResolvedValue([product({ averageCost: null })]);
      // Deliberately NOT the fixture's 10: the movement must carry the counter the UPDATE returned.
      prisma.product.update.mockResolvedValue({ currentStock: D(7) } as any);

      await service.setCostBasis("prod-1", { unitCost: 3.15, notes: "opening basis" }, "user-1");

      const movementArgs = prisma.stockMovement.create.mock.calls[0][0].data;
      expect(movementArgs.type).toBe("COST_BASIS");
      expect(movementArgs.quantity).toBe(0);
      expect(movementArgs.unitCost.toString()).toBe("3.15");
      expect(movementArgs.avgCostAfter.toString()).toBe("3.15");
      expect(movementArgs.stockAfter.toString()).toBe("7");
      expect(movementArgs.performedById).toBe("user-1");

      expect(prisma.product.update).toHaveBeenCalledWith({
        where: { id: "prod-1" },
        data: { averageCost: D(3.15) },
        select: { currentStock: true },
      });
      // Lots untouched unless explicitly requested
      expect(prisma.stockLot.updateMany).not.toHaveBeenCalled();
    });

    it("rewrites open lots only when applyToLots is set", async () => {
      prisma.product.findUnique.mockResolvedValue(product());
      prisma.product.findMany.mockResolvedValue([product()]);

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

  describe("recomputeCosts (B562 PR-3, SA-136 §4: history-preserving)", () => {
    // The §0 pair: buy 10 @ $1, sell 8, buy 10 @ $3 → true average (2×1 + 10×3)/12 = 2.6667.
    const pair = [
      {
        id: "m1",
        type: "PURCHASE",
        quantity: D(10),
        unitCost: D(1),
        reference: null,
        avgCostAfter: D(1),
      },
      {
        id: "m2",
        type: "SALE",
        quantity: D(-8),
        unitCost: null,
        reference: "ORDER:o1",
        avgCostAfter: D(1),
      },
      {
        id: "m3",
        type: "PURCHASE",
        quantity: D(10),
        unitCost: D(3),
        reference: null,
        avgCostAfter: D("2.6667"),
      },
    ];
    const pairProduct = () => product({ currentStock: D(12), averageCost: D(2) }); // sales-blind 2.0

    it("dry run is the DEFAULT: reports the corrected average and writes nothing", async () => {
      prisma.product.findMany.mockResolvedValue([pairProduct()]);
      prisma.stockMovement.findMany.mockResolvedValue(pair);

      const result = await service.recomputeCosts({});

      expect(result.dryRun).toBe(true);
      expect(result.results[0]).toMatchObject({
        productId: "prod-1",
        gap: 0,
        oldAvgCost: 2,
        newAvgCost: 2.6667,
        correctionId: null,
      });
      expect(prisma.stockMovement.create).not.toHaveBeenCalled();
      expect(prisma.stockMovement.update).not.toHaveBeenCalled();
      expect(prisma.product.update).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    });

    it("apply APPENDS one dated COST_BASIS correction, sets averageCost, rewrites no row, audits", async () => {
      prisma.product.findMany.mockResolvedValue([pairProduct()]);
      prisma.stockMovement.findMany.mockResolvedValue(pair);
      prisma.product.update.mockResolvedValue({ currentStock: D(12) } as any);
      prisma.stockMovement.create.mockResolvedValue({ id: "corr-1" } as any);

      const result = await service.recomputeCosts(
        { dryRun: false, reason: "B562 check" },
        "admin-1",
      );

      expect(result).toMatchObject({ dryRun: false, updated: 1 });
      expect(result.results[0]).toMatchObject({ correctionId: "corr-1", newAvgCost: 2.6667 });
      // Snapshots are write-once: no existing movement is touched.
      expect(prisma.stockMovement.update).not.toHaveBeenCalled();
      expect(prisma.product.update).toHaveBeenCalledWith({
        where: { id: "prod-1" },
        data: { averageCost: D("2.6667") },
        select: { currentStock: true },
      });
      const row = prisma.stockMovement.create.mock.calls[0][0].data;
      expect(row).toMatchObject({
        productId: "prod-1",
        type: "COST_BASIS",
        reference: "RECOMPUTE:ENDPOINT",
        notes: "2 → 2.6667",
        performedById: "admin-1",
      });
      expect(row.quantity.toString()).toBe("0");
      expect(row.unitCost.toString()).toBe("2.6667");
      expect(row.avgCostAfter.toString()).toBe("2.6667");
      expect(row.stockAfter.toString()).toBe("12"); // the counter the update returned
      expect(row.effectiveAt).toBeUndefined(); // dated now (column default)
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "INVENTORY_RECOMPUTE_COSTS_APPLY",
          userId: "admin-1",
          meta: expect.objectContaining({
            reason: "B562 check",
            corrections: [
              { productId: "prod-1", oldAvgCost: 2, newAvgCost: 2.6667, correctionId: "corr-1" },
            ],
          }),
        }),
      );
    });

    it("an average already within 0.0001 writes no correction", async () => {
      prisma.product.findMany.mockResolvedValue([
        product({ currentStock: D(12), averageCost: D("2.6667") }),
      ]);
      prisma.stockMovement.findMany.mockResolvedValue(pair);

      const result = await service.recomputeCosts({ dryRun: false });

      expect(result.updated).toBe(0);
      expect(result.results[0].correctionId).toBeNull();
      expect(prisma.stockMovement.create).not.toHaveBeenCalled();
      expect(prisma.product.update).not.toHaveBeenCalled();
    });

    it("a right averageCost with a STALE as-of-now snapshot still gets the dated correction the cost index reads", async () => {
      // Purchase-only ledger, backdated row inserted last: the average is order-independent (so
      // averageCost is right), but the LAST row in accounting order still holds its old 10.6667.
      prisma.product.findMany.mockResolvedValue([
        product({ currentStock: D(250), averageCost: D("14.4") }),
      ]);
      prisma.stockMovement.findMany.mockResolvedValue([
        {
          id: "d1",
          type: "PURCHASE",
          quantity: D(100),
          unitCost: D(10),
          reference: null,
          avgCostAfter: D(10),
        },
        {
          id: "d2",
          type: "PURCHASE",
          quantity: D(100),
          unitCost: D(20),
          reference: null,
          avgCostAfter: D("14.4"),
        },
        {
          id: "d4",
          type: "PURCHASE",
          quantity: D(50),
          unitCost: D(12),
          reference: null,
          avgCostAfter: D("10.6667"),
        },
      ]);
      prisma.product.update.mockResolvedValue({ currentStock: D(250) } as any);
      prisma.stockMovement.create.mockResolvedValue({ id: "corr-t" } as any);

      const result = await service.recomputeCosts({ dryRun: false });

      expect(result.results[0]).toMatchObject({
        oldAvgCost: 14.4,
        newAvgCost: 14.4,
        correctionId: "corr-t",
      });
      expect(prisma.stockMovement.create.mock.calls[0][0].data.notes).toBe(
        "as-of-now snapshot 10.6667 → 14.4",
      );
    });

    it("a replay's own RECOMPUTE: correction is never folded back in (it would pin a stale average)", async () => {
      // A correction to 2.6667 was written after m3; then a purchase dated BEFORE the sale landed.
      // Folding the correction would reset the average to 2.6667 at its date and erase m4.
      prisma.product.findMany.mockResolvedValue([
        product({ currentStock: D(22), averageCost: D("2.6667") }),
      ]);
      prisma.stockMovement.findMany.mockResolvedValue([
        pair[0],
        { id: "m4", type: "PURCHASE", quantity: D(10), unitCost: D(5), reference: null },
        pair[1],
        pair[2],
        {
          id: "c1",
          type: "COST_BASIS",
          quantity: D(0),
          unitCost: D("2.6667"),
          reference: "RECOMPUTE:ENDPOINT",
        },
      ]);

      const result = await service.recomputeCosts({});

      // 10@1 + 10@5 → 20 @ 3; sell 8 → 12 @ 3; + 10@3 → 22 @ 3.
      expect(result.results[0].newAvgCost).toBe(3);
    });

    it("SA-372: a replay correction needs all three marks (COST_BASIS, quantity 0, RECOMPUTE: prefix)", () => {
      const row = (type: string, quantity: number, reference: string | null) =>
        isReplayCorrection({ type, quantity: D(quantity), reference });

      expect(row("COST_BASIS", 0, "RECOMPUTE:ENDPOINT")).toBe(true);
      expect(row("COST_BASIS", 0, "RECOMPUTE:PURCHASE:m9")).toBe(true);
      expect(row("COST_BASIS", 1, "RECOMPUTE:ENDPOINT")).toBe(false); // moves stock: an input
      expect(row("PURCHASE", 0, "RECOMPUTE:ENDPOINT")).toBe(false); // wrong type
      expect(row("COST_BASIS", 0, null)).toBe(false); // manual setCostBasis writes no reference
      expect(row("COST_BASIS", 0, "B562:REPAIR:abc")).toBe(false); // D2 repair rows stay inputs
    });

    it("SA-372: a manual COST_BASIS dated between two purchases is folded at its place", async () => {
      prisma.product.findMany.mockResolvedValue([
        product({ currentStock: D(20), averageCost: D(3) }),
      ]);
      prisma.stockMovement.findMany.mockResolvedValue([
        { id: "m1", type: "PURCHASE", quantity: D(10), unitCost: D(1), reference: null },
        { id: "b1", type: "COST_BASIS", quantity: D(0), unitCost: D(4), reference: null },
        { id: "m2", type: "PURCHASE", quantity: D(10), unitCost: D(2), reference: null },
      ]);

      const result = await service.recomputeCosts({});

      // 10 @ 1, re-based to 4, then + 10 @ 2 → (40 + 20) / 20 = 3. Skipping b1 would give 1.5.
      expect(result.results[0].newAvgCost).toBe(3);
    });

    it("a manual COST_BASIS stays an input to the fold", async () => {
      prisma.product.findMany.mockResolvedValue([
        product({ currentStock: D(10), averageCost: D(1) }),
      ]);
      prisma.stockMovement.findMany.mockResolvedValue([
        { id: "m1", type: "PURCHASE", quantity: D(10), unitCost: D(1), reference: null },
        { id: "b1", type: "COST_BASIS", quantity: D(0), unitCost: D(4), reference: null },
      ]);

      const result = await service.recomputeCosts({});

      expect(result.results[0].newAvgCost).toBe(4);
    });

    it("reports products with no costful history and leaves their average untouched", async () => {
      prisma.product.findMany.mockResolvedValue([
        product({ averageCost: null, currentStock: D(2) }),
      ]);
      prisma.stockMovement.findMany.mockResolvedValue([
        { id: "m1", type: "SALE", quantity: D(-2), unitCost: null, reference: null },
        { id: "m2", type: "ADJUSTMENT", quantity: D(4), unitCost: null, reference: null },
      ]);

      const result = await service.recomputeCosts({ dryRun: false });

      expect(result.updated).toBe(0);
      expect(result.noHistory).toEqual([{ productId: "prod-1", name: "Flour 25lb" }]);
      expect(prisma.product.update).not.toHaveBeenCalled();
    });

    // B562 / L-207: currentStock 10 but the ledger explains only 6 — the fold ran on a wrong stock
    // balance, so the product is refused and reported, never corrected, dry run or not.
    it("reports a stock-drift gap and writes nothing for it, while correcting the clean product", async () => {
      prisma.product.findMany.mockResolvedValue([
        product({ id: "prod-1", name: "Gapped", currentStock: D(10) }),
        product({ id: "prod-2", name: "Clean", currentStock: D(6), averageCost: D(9.99) }),
      ]);
      prisma.stockMovement.findMany.mockImplementation(({ where }: any) =>
        Promise.resolve(
          where.productId === "prod-1"
            ? [{ id: "m1", type: "PURCHASE", quantity: D(6), unitCost: D(2), reference: null }]
            : [{ id: "m2", type: "PURCHASE", quantity: D(6), unitCost: D(3), reference: null }],
        ),
      );
      prisma.product.update.mockResolvedValue({ currentStock: D(6) } as any);
      prisma.stockMovement.create.mockResolvedValue({ id: "corr-2" } as any);

      const result = await service.recomputeCosts({ dryRun: false });

      expect(result.gapsDetected).toEqual([{ productId: "prod-1", name: "Gapped", stockDrift: 4 }]);
      expect(result.results).toEqual([
        expect.objectContaining({ productId: "prod-2", newAvgCost: 3, correctionId: "corr-2" }),
      ]);
      expect(prisma.product.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "prod-1" } }),
      );
      expect(prisma.stockMovement.create).toHaveBeenCalledTimes(1);
      expect(prisma.stockMovement.update).not.toHaveBeenCalled();
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

    it("values a LIFO-labelled product at the weighted average too (B1233 guard: valuation = sale cost)", async () => {
      prisma.product.findMany.mockResolvedValue([
        product({ costingMethod: "LIFO", currentStock: D(10), averageCost: D(2) }),
      ]);

      const result = await service.getValuation();

      expect(result.totalValue).toBe(20);
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

    // SA-767 L-2.2: the commit flips the session by CAS after the last batch.
    beforeEach(() => {
      prisma.stockCountSession.updateMany.mockResolvedValue({ count: 1 });
      // The edits probe the shared stock-count lock; it fails closed, so grant it explicitly.
      prisma.tenantTransaction.mockImplementation((fn: any) =>
        fn({
          ...prisma,
          $executeRaw: jest.fn().mockResolvedValue(0),
          $queryRaw: jest.fn().mockResolvedValue([{ ok: true }]),
        }),
      );
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

    it("a line whose movement already exists is skipped on a re-run; the interrupted commit finishes", async () => {
      prisma.stockCountSession.findUnique.mockResolvedValue(session());
      prisma.product.findMany.mockResolvedValue([product()]);
      prisma.stockMovement.findMany.mockResolvedValue([
        { id: "m-existing", productId: "prod-1", type: "ADJUSTMENT" },
      ]);

      const res = await service.commitStockCountSession("sess-1", {}, { sub: "user-1" });

      // not re-applied, counted in the complete movement set, and the session is flipped by the CAS
      expect(res).toMatchObject({ applied: 1, movementIds: ["m-existing"] });
      expect(res).not.toHaveProperty("alreadyCommitted");
      expect(prisma.stockMovement.create).not.toHaveBeenCalled();
      expect(prisma.product.update).not.toHaveBeenCalled();
      expect(prisma.stockCountSession.updateMany).toHaveBeenCalledTimes(1);
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

    it("stamps expectedQty on the first count and re-stamps it on an absolute recount (SA-767 L-2.4 A)", async () => {
      prisma.stockCountSession.findFirst.mockResolvedValue({ id: "sess-1", status: "OPEN" });
      prisma.product.findFirst.mockResolvedValue({
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

      // An absolute recount re-stamps the baseline from the live stock (10); a scan does not.
      prisma.stockCountLine.findUnique.mockResolvedValue(line({ countedQty: D(4) }));
      await service.upsertStockCountLine(
        "sess-1",
        { productId: "prod-1", countedQty: 6 },
        { sub: "user-1" },
      );
      expect(prisma.stockCountLine.update).toHaveBeenCalled();
      expect(Number(prisma.stockCountLine.update.mock.calls[0][0].data.expectedQty)).toBe(10);
    });

    it("increment adds to the running count; without it the value replaces", async () => {
      prisma.stockCountSession.findFirst.mockResolvedValue({ id: "sess-1", status: "OPEN" });
      prisma.product.findFirst.mockResolvedValue({
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
      prisma.stockCountSession.findFirst.mockResolvedValue({ id: "sess-1", status: "OPEN" });
      prisma.product.findFirst.mockResolvedValue({
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
      prisma.stockCountSession.findFirst.mockResolvedValue({
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

      const result = await service.recomputeCosts({ dryRun: false });

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

  // ─── B562 PR-1 (SA-136 §3): effectiveAt is the accounting date ─────────────
  describe("B562 effectiveAt", () => {
    const at = "2026-06-01T00:00:00.000Z";

    it("a backdated purchase writes effectiveAt = effectiveDate, leaves createdAt to the DB, and counts later rows by effectiveAt", async () => {
      prisma.product.findUnique.mockResolvedValue(product());
      prisma.stockMovement.count.mockResolvedValue(0);

      await service.recordPurchase(
        { productId: "prod-1", quantity: 5, unitCost: 3.5, effectiveDate: at } as any,
        "user-1",
      );

      const data = prisma.stockMovement.create.mock.calls[0][0].data;
      expect(data.effectiveAt).toEqual(new Date(at));
      expect(data).not.toHaveProperty("createdAt");
      expect(prisma.stockMovement.count).toHaveBeenCalledWith({
        where: { productId: "prod-1", effectiveAt: { gt: new Date(at) } },
      });
    });

    it("a backdated adjustment writes effectiveAt = effectiveDate and leaves createdAt to the DB", async () => {
      prisma.product.findUnique.mockResolvedValue(product());
      prisma.stockMovement.count.mockResolvedValue(0);

      await service.recordAdjustment(
        { productId: "prod-1", quantity: 2, effectiveDate: at } as any,
        "user-1",
      );

      const data = prisma.stockMovement.create.mock.calls[0][0].data;
      expect(data.effectiveAt).toEqual(new Date(at));
      expect(data).not.toHaveProperty("createdAt");
      expect(prisma.stockMovement.count).toHaveBeenCalledWith({
        where: { productId: "prod-1", effectiveAt: { gt: new Date(at) } },
      });
    });

    it("the cost replay reads the ledger in accounting order: effectiveAt, then createdAt, then id", async () => {
      prisma.product.findMany.mockResolvedValue([product()]);
      prisma.stockMovement.findMany.mockResolvedValue([]);

      await service.recomputeCosts({ dryRun: true });

      expect(prisma.stockMovement.findMany.mock.calls[0][0].orderBy).toEqual([
        { effectiveAt: "asc" },
        { createdAt: "asc" },
        { id: "asc" },
      ]);
    });

    it("the movement list filters and sorts on effectiveAt", async () => {
      prisma.stockMovement.findMany.mockResolvedValue([]);
      prisma.stockMovement.count.mockResolvedValue(0);

      await service.listMovements({ from: "2026-06-01", to: "2026-06-30" } as any);

      const args = prisma.stockMovement.findMany.mock.calls[0][0];
      expect(args.where.effectiveAt.gte).toEqual(new Date("2026-06-01"));
      expect(args.where.effectiveAt.lte.toISOString()).toBe("2026-06-30T23:59:59.999Z");
      expect(args.where).not.toHaveProperty("createdAt");
      expect(args.orderBy).toEqual([
        { effectiveAt: "desc" },
        { createdAt: "desc" },
        { id: "desc" },
      ]);
    });
  });

  // ─── SA-802: stockWriteDate — a person-chosen stock date can't land in a filed period ──────────
  describe("SA-802 stockWriteDate", () => {
    const FILED = "2026-09-15T00:00:00.000Z"; // inside the filed September
    const tomorrow = () => new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    const tobaccoProduct = () => product({ isTobacco: true, trackedCategoryId: null });
    const plainProduct = () => product({ id: "prod-2", isTobacco: false, trackedCategoryId: null });
    /** product.findMany answers by the requested ids: prod-1 is tobacco, prod-2 is unregulated. */
    const productsById = () =>
      prisma.product.findMany.mockImplementation(async (args: any) =>
        [tobaccoProduct(), plainProduct()].filter((p) => args?.where?.id?.in?.includes(p.id)),
      );

    beforeEach(() => {
      // September 2026 tobacco is GENERATED (periodEnd is the inclusive last instant).
      prisma.tobaccoReport.findFirst.mockResolvedValue({
        periodStart: new Date("2026-09-01T00:00:00.000Z"),
        periodEnd: new Date("2026-09-30T23:59:59.999Z"),
      });
      prisma.product.findMany.mockResolvedValue([tobaccoProduct()]);
      prisma.product.findUnique.mockResolvedValue(tobaccoProduct());
      prisma.stockMovement.count.mockResolvedValue(0);
    });

    const expectNothingWritten = () => {
      expect(prisma.stockMovement.create).not.toHaveBeenCalled();
      expect(prisma.product.update).not.toHaveBeenCalled();
      expect(prisma.stockLot.create).not.toHaveBeenCalled();
    };
    const filedRefusal = {
      constructor: ConflictException,
      response: expect.objectContaining({ code: "STOCK_DATE_IN_FILED_PERIOD" }),
    };

    it("C2: an adjustment backdated into a filed tobacco month is a 409 and writes nothing", async () => {
      await expect(
        service.recordAdjustment(
          { productId: "prod-1", quantity: 3, effectiveDate: FILED } as any,
          "user-1",
        ),
      ).rejects.toMatchObject(filedRefusal);
      expectNothingWritten();
    });

    it("C2: a purchase backdated into a filed tobacco month is a 409 and writes nothing", async () => {
      await expect(
        service.recordPurchase(
          { productId: "prod-1", quantity: 5, unitCost: 3.5, effectiveDate: FILED } as any,
          "user-1",
        ),
      ).rejects.toMatchObject(filedRefusal);
      expectNothingWritten();
    });

    it("C2: today's date (no effectiveDate) is still accepted on a tobacco product", async () => {
      await service.recordAdjustment({ productId: "prod-1", quantity: 3 } as any, "user-1");
      await service.recordPurchase({ productId: "prod-1", quantity: 5, unitCost: 3.5 } as any, "u");
      expect(prisma.stockMovement.create).toHaveBeenCalledTimes(2);
    });

    describe("C3: legacy commitStockCount", () => {
      const count = (effectiveDate: string) =>
        ({
          sessionId: "22222222-2222-2222-2222-222222222222",
          effectiveDate,
          items: [
            { productId: "prod-1", quantity: 5, mode: "ADD" },
            { productId: "prod-1", quantity: 1, mode: "ADD" },
          ],
        }) as any;

      it("a filed date is a 409 and nothing is written", async () => {
        await expect(service.commitStockCount(count(FILED), "user-1")).rejects.toMatchObject(
          filedRefusal,
        );
        expectNothingWritten();
      });

      it("the gate reads ALL items: an unregulated first item and a tobacco second item is a 409", async () => {
        productsById();
        const mixed = {
          sessionId: "22222222-2222-2222-2222-222222222222",
          effectiveDate: FILED,
          items: [
            { productId: "prod-2", quantity: 5, mode: "ADD" },
            { productId: "prod-1", quantity: 1, mode: "ADD" },
          ],
        } as any;
        await expect(service.commitStockCount(mixed, "user-1")).rejects.toMatchObject(filedRefusal);
        expectNothingWritten();
      });

      it("a lost-response retry after the month was filed returns the prior result, not a 409", async () => {
        prisma.stockMovement.findFirst.mockResolvedValue({ id: "existing-1" });
        prisma.stockMovement.findMany.mockResolvedValue([{ id: "existing-1" }]);
        const result = await service.commitStockCount(count(FILED), "user-1");
        expect(result).toMatchObject({ applied: 1, alreadyCommitted: true });
        expect(prisma.stockMovement.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { reference: "STOCK_COUNT-22222222-2222-2222-2222-222222222222" },
          }),
        );
        expectNothingWritten();
      });

      it("tomorrow is a 400 (the legacy path had no future bound) and nothing is written", async () => {
        await expect(service.commitStockCount(count(tomorrow()), "user-1")).rejects.toBeInstanceOf(
          BadRequestException,
        );
        expectNothingWritten();
      });
    });

    describe("C3: commitStockCountSession", () => {
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

      beforeEach(() => {
        prisma.stockCountSession.findUnique.mockResolvedValue({
          id: "sess-1",
          status: "OPEN",
          movementReference: null,
          lines: [line(), line({ id: "line-2" })],
        });
        prisma.stockCountSession.updateMany.mockResolvedValue({ count: 1 });
        prisma.tenantTransaction.mockImplementation((fn: any) =>
          fn({
            ...prisma,
            $executeRaw: jest.fn().mockResolvedValue(0),
            $queryRaw: jest.fn().mockResolvedValue([{ ok: true }]),
          }),
        );
      });

      it("a filed date is a 409 and the batch body never runs", async () => {
        await expect(
          service.commitStockCountSession("sess-1", { effectiveDate: FILED } as any, {
            sub: "user-1",
          }),
        ).rejects.toMatchObject(filedRefusal);
        expectNothingWritten();
        expect(prisma.stockCountSession.updateMany).not.toHaveBeenCalled();
      });

      it("the gate reads ALL lines: an unregulated first line and a tobacco second line is a 409", async () => {
        productsById();
        prisma.stockCountSession.findUnique.mockResolvedValue({
          id: "sess-1",
          status: "OPEN",
          movementReference: null,
          lines: [line({ productId: "prod-2" }), line({ id: "line-2", productId: "prod-1" })],
        });
        await expect(
          service.commitStockCountSession("sess-1", { effectiveDate: FILED } as any, {
            sub: "user-1",
          }),
        ).rejects.toMatchObject(filedRefusal);
        expectNothingWritten();
        expect(prisma.stockCountSession.updateMany).not.toHaveBeenCalled();
      });

      it("a tobacco line added while the commit waited for the lock is gated on the re-read lines", async () => {
        productsById();
        const open = (lines: unknown[]) => ({
          id: "sess-1",
          status: "OPEN",
          movementReference: null,
          startedAt: null,
          lines,
        });
        // Pre-lock read: an unregulated line only (the gate passes). Under-lock re-read: a tobacco
        // line has landed (an in-flight upsertStockCountLine) in the filed month.
        prisma.stockCountSession.findUnique
          .mockResolvedValueOnce(open([line({ productId: "prod-2" })]))
          .mockResolvedValue(
            open([line({ productId: "prod-2" }), line({ id: "line-2", productId: "prod-1" })]),
          );
        await expect(
          service.commitStockCountSession("sess-1", { effectiveDate: FILED } as any, {
            sub: "user-1",
          }),
        ).rejects.toMatchObject(filedRefusal);
        expectNothingWritten();
        expect(prisma.stockCountSession.updateMany).not.toHaveBeenCalled();
      });

      it("tomorrow is a 400 and the batch body never runs", async () => {
        await expect(
          service.commitStockCountSession("sess-1", { effectiveDate: tomorrow() } as any, {
            sub: "user-1",
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expectNothingWritten();
        expect(prisma.stockCountSession.updateMany).not.toHaveBeenCalled();
      });
    });
  });
});
