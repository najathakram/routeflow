jest.mock("../common/db-locks", () => ({
  ...jest.requireActual("../common/db-locks"),
  withAdvisoryLock: async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  }),
}));

import { Test } from "@nestjs/testing";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { InventoryService } from "./inventory.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { StockAlertService } from "../stock-alerts/stock-alert.service";
import { AuditService } from "../audit/audit.service";

/**
 * SA-828 (row 657) + SA-804(3): `countProduct` (set a product's stock to a count, or adjust it by
 * a delta, entered in one of its units) and the reasons every manual stock write now carries.
 */
const D = (n: number | string) => new Prisma.Decimal(n);

const row = (over: Record<string, unknown> = {}) => ({
  id: "prod-1",
  name: "Widget",
  kind: "STANDARD",
  isActive: true,
  unit: "Box",
  baseUnitLabel: null,
  packLabel: null,
  unitsPerBox: 12,
  currentStock: D(20),
  averageCost: D(2),
  costingMethod: "AVCO",
  ...over,
});

describe("InventoryService reasons and countProduct (SA-828 / SA-804(3))", () => {
  let service: InventoryService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let stockAlerts: { fireForProducts: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    stockAlerts = { fireForProducts: jest.fn().mockResolvedValue({ notified: 0 }) };
    (prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) =>
      fn({
        ...prisma,
        $executeRaw: jest.fn().mockResolvedValue(0),
        $queryRaw: jest.fn().mockResolvedValue([]),
      }),
    );
    prisma.stockMovement.count.mockResolvedValue(0);
    prisma.stockMovement.create.mockResolvedValue({ id: "mv-1" });
    prisma.product.findUnique.mockResolvedValue(row());
    prisma.product.findMany.mockResolvedValue([row()]);
    prisma.productUnit.findMany.mockResolvedValue([
      { productId: "prod-1", label: "Case", factorToBase: 12, price: null },
    ]);
    const mod = await Test.createTestingModule({
      providers: [
        InventoryService,
        { provide: PrismaService, useValue: prisma },
        { provide: StockAlertService, useValue: stockAlerts },
        { provide: AuditService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();
    service = mod.get(InventoryService);
  });

  const nothingWritten = () => {
    expect(prisma.stockMovement.create).not.toHaveBeenCalled();
    expect(prisma.product.update).not.toHaveBeenCalled();
    expect(prisma.stockLot.create).not.toHaveBeenCalled();
    expect(prisma.tenantTransaction).not.toHaveBeenCalled();
  };
  const movement = () => prisma.stockMovement.create.mock.calls[0][0].data;

  describe("recordAdjustment carries the reason", () => {
    it("writes reason and reasonNote on the movement", async () => {
      prisma.product.update.mockResolvedValue({ currentStock: D(17) });
      await service.recordAdjustment(
        {
          productId: "prod-1",
          quantity: -3,
          reason: "OTHER",
          reasonNote: "  Pallet fell off the truck  ",
        } as any,
        "u-1",
      );
      expect(movement().reason).toBe("OTHER");
      expect(movement().reasonNote).toBe("Pallet fell off the truck");
    });

    it("a reason with no note stores a null note", async () => {
      prisma.product.update.mockResolvedValue({ currentStock: D(17) });
      await service.recordAdjustment(
        { productId: "prod-1", quantity: -3, reason: "DAMAGED" } as any,
        "u-1",
      );
      expect(movement().reason).toBe("DAMAGED");
      expect(movement().reasonNote).toBeNull();
    });
  });

  describe("count commits write COUNT_CORRECTION", () => {
    it("the legacy commitStockCount stamps it on every movement", async () => {
      prisma.product.update.mockResolvedValue({ currentStock: D(90) });
      prisma.stockMovement.findMany.mockResolvedValue([]);
      await service.commitStockCount(
        {
          sessionId: "s-1",
          items: [{ productId: "prod-1", quantity: 90, mode: "REPLACE" }],
        } as any,
        "u-1",
      );
      expect(movement().reason).toBe("COUNT_CORRECTION");
    });
  });

  describe("countProduct", () => {
    const set = (over: Record<string, unknown> = {}) =>
      ({
        mode: "SET",
        count: { unit: "Case", quantity: 3 },
        reason: "COUNT_CORRECTION",
        ...over,
      }) as any;
    const adjust = (over: Record<string, unknown> = {}) =>
      ({
        mode: "ADJUST",
        delta: { unit: "Case", quantity: 1, sign: "-" },
        reason: "DAMAGED",
        ...over,
      }) as any;

    it("SET 3 Case (Case = 12) over 20 pieces writes ONE ADJUSTMENT of +16 with its reason", async () => {
      prisma.product.update.mockResolvedValue({ currentStock: D(36) });

      const result = await service.countProduct(
        "prod-1",
        set({ reason: "OTHER", reasonNote: "Recounted the back room" }),
        "u-1",
      );

      expect(prisma.stockMovement.create).toHaveBeenCalledTimes(1);
      expect(prisma.product.update.mock.calls[0][0].data).toEqual({
        currentStock: { increment: D(16) },
      });
      const m = movement();
      expect(m.type).toBe("ADJUSTMENT");
      expect(m.quantity.toString()).toBe("16");
      expect(m.stockAfter.toString()).toBe("36");
      expect(m.reason).toBe("OTHER");
      expect(m.reasonNote).toBe("Recounted the back room");
      expect(m.reference).toBe("PRODUCT_COUNT");
      expect(m.performedById).toBe("u-1");
      expect(result).toEqual({
        productId: "prod-1",
        mode: "SET",
        deltaPieces: 16,
        stockBefore: 20,
        stockAfter: 36,
        movementId: "mv-1",
      });
      // a gain opens a lot and fires the stock alerts after the commit
      expect(prisma.stockLot.create.mock.calls[0][0].data.qty.toString()).toBe("16");
      expect(stockAlerts.fireForProducts).toHaveBeenCalledWith(["prod-1"]);
    });

    it("ADJUST -1 Case on a ladder whose Case is 24 writes -24 (the server's factor, not 12)", async () => {
      prisma.productUnit.findMany.mockResolvedValue([
        { productId: "prod-1", label: "Case", factorToBase: 24, price: null },
      ]);
      prisma.product.findMany.mockResolvedValue([row({ currentStock: D(100) })]);
      prisma.product.update.mockResolvedValue({ currentStock: D(76) });

      const result = await service.countProduct("prod-1", adjust(), "u-1");

      expect(movement().quantity.toString()).toBe("-24");
      expect(movement().reason).toBe("DAMAGED");
      expect(result).toMatchObject({ deltaPieces: -24, stockBefore: 100, stockAfter: 76 });
      expect(prisma.stockLot.create).not.toHaveBeenCalled();
      expect(stockAlerts.fireForProducts).not.toHaveBeenCalled();
    });

    it("ADJUST +2 Piece is +2; a fractional Piece is allowed", async () => {
      prisma.product.update.mockResolvedValue({ currentStock: D(22.5) });
      await service.countProduct(
        "prod-1",
        adjust({ delta: { unit: "Piece", quantity: 2.5, sign: "+" } }),
        "u-1",
      );
      expect(movement().quantity.toString()).toBe("2.5");
    });

    it("a fractional Case is a 400 COUNT_FRACTIONAL_PACK and nothing is written", async () => {
      await expect(
        service.countProduct("prod-1", set({ count: { unit: "Case", quantity: 1.5 } }), "u-1"),
      ).rejects.toMatchObject({
        constructor: BadRequestException,
        response: { code: "COUNT_FRACTIONAL_PACK", message: expect.stringContaining("Cases") },
      });
      nothingWritten();
    });

    it("a SET equal to the stock writes no movement and returns movementId null", async () => {
      // 20 pieces on hand = 20 Piece
      const result = await service.countProduct(
        "prod-1",
        set({ count: { unit: "Piece", quantity: 20 } }),
        "u-1",
      );
      expect(result).toEqual({
        productId: "prod-1",
        mode: "SET",
        deltaPieces: 0,
        stockBefore: 20,
        stockAfter: 20,
        movementId: null,
      });
      expect(prisma.stockMovement.create).not.toHaveBeenCalled();
      expect(prisma.product.update).not.toHaveBeenCalled();
      expect(stockAlerts.fireForProducts).not.toHaveBeenCalled();
    });

    it("a SET below the stock writes a negative delta and no lot", async () => {
      prisma.product.update.mockResolvedValue({ currentStock: D(12) });
      const result = await service.countProduct(
        "prod-1",
        set({ count: { unit: "Case", quantity: 1 }, reason: "THEFT" }),
        "u-1",
      );
      expect(movement().quantity.toString()).toBe("-8");
      expect(movement().reason).toBe("THEFT");
      expect(result.deltaPieces).toBe(-8);
      expect(prisma.stockLot.create).not.toHaveBeenCalled();
    });

    it("an ADJUST of zero pieces is a 400", async () => {
      await expect(
        service.countProduct(
          "prod-1",
          adjust({ delta: { unit: "Piece", quantity: 0, sign: "+" } }),
          "u-1",
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      nothingWritten();
    });

    it("an unknown unit is the ladder's 400 UNIT_NOT_OFFERED", async () => {
      await expect(
        service.countProduct("prod-1", set({ count: { unit: "Drum", quantity: 1 } }), "u-1"),
      ).rejects.toMatchObject({ response: { code: "UNIT_NOT_OFFERED" } });
      nothingWritten();
    });

    it("a factor the client sends is never read", async () => {
      prisma.product.update.mockResolvedValue({ currentStock: D(36) });
      await service.countProduct(
        "prod-1",
        set({ count: { unit: "Case", quantity: 3, unitsPerBox: 1000, factor: 1000 } }),
        "u-1",
      );
      expect(movement().quantity.toString()).toBe("16"); // 3 x 12 - 20, not 3 x 1000
    });

    it("a product that is not there is a 404", async () => {
      prisma.product.findUnique.mockResolvedValue(null);
      await expect(service.countProduct("nope", set(), "u-1")).rejects.toBeInstanceOf(
        NotFoundException,
      );
      nothingWritten();
    });

    it("a FAMILY is refused (it is never stocked)", async () => {
      prisma.product.findUnique.mockResolvedValue(row({ kind: "FAMILY" }));
      await expect(service.countProduct("prod-1", set(), "u-1")).rejects.toMatchObject({
        response: { code: "FAMILY_NOT_SELLABLE" },
      });
      nothingWritten();
    });

    it("a date inside a filed period is a 409 before anything is locked or written", async () => {
      prisma.tobaccoReport.findFirst.mockResolvedValue({
        periodStart: new Date("2026-09-01T00:00:00.000Z"),
        periodEnd: new Date("2026-09-30T23:59:59.999Z"),
      });
      const tobacco = row({ isTobacco: true, trackedCategoryId: null });
      prisma.product.findUnique.mockResolvedValue(tobacco);
      prisma.product.findMany.mockResolvedValue([tobacco]);
      await expect(
        service.countProduct("prod-1", set({ effectiveDate: "2026-09-15T00:00:00.000Z" }), "u-1"),
      ).rejects.toMatchObject({
        constructor: ConflictException,
        response: expect.objectContaining({ code: "STOCK_DATE_IN_FILED_PERIOD" }),
      });
      nothingWritten();
    });

    it("a future date is a 400 before any write", async () => {
      await expect(
        service.countProduct(
          "prod-1",
          set({ effectiveDate: new Date(Date.now() + 86_400_000).toISOString() }),
          "u-1",
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      nothingWritten();
    });

    it("the delta is read from the LOCKED stock, not the pre-tx read", async () => {
      // a sale left 14 by the time the lock was granted
      prisma.product.findMany.mockResolvedValue([row({ currentStock: D(14) })]);
      prisma.product.update.mockResolvedValue({ currentStock: D(36) });
      const result = await service.countProduct("prod-1", set(), "u-1");
      expect(movement().quantity.toString()).toBe("22"); // 36 - 14
      expect(result.stockBefore).toBe(14);
    });

    it("a backdated count replays the product from that date", async () => {
      prisma.product.update.mockResolvedValue({ currentStock: D(36) });
      prisma.stockMovement.count.mockResolvedValue(2); // two movements are newer than the count's date
      const spy = jest.spyOn(service, "recomputeProductInTx").mockResolvedValue(undefined as never);
      await service.countProduct("prod-1", set({ effectiveDate: "2026-10-01" }), "u-1");
      expect(spy).toHaveBeenCalledWith(
        expect.anything(),
        "prod-1",
        expect.objectContaining({ trigger: "PRODUCT_COUNT:mv-1", performedById: "u-1" }),
      );
    });

    it("an undated count does not replay", async () => {
      prisma.product.update.mockResolvedValue({ currentStock: D(36) });
      const spy = jest.spyOn(service, "recomputeProductInTx").mockResolvedValue(undefined as never);
      await service.countProduct("prod-1", set(), "u-1");
      expect(spy).not.toHaveBeenCalled();
    });
  });
});
