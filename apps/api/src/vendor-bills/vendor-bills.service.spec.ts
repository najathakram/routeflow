import { Test, TestingModule } from "@nestjs/testing";
import { ConflictException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import { VendorBillsService } from "./vendor-bills.service";
import { PrismaService } from "../prisma/prisma.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { createMockPrisma } from "../testing/prisma-mock";

const D = (n: number | string) => new Prisma.Decimal(n);

const linkedItem = (overrides: Record<string, unknown> = {}) => ({
  id: "item-1",
  productId: "prod-1",
  description: "Flour 25lb",
  qty: D(5),
  unitCost: D(3.5),
  product: { id: "prod-1", name: "Flour 25lb", currentStock: D(10), averageCost: D(2) },
  ...overrides,
});

const bill = (overrides: Record<string, unknown> = {}) => ({
  id: "bill-1",
  billNumber: "BILL-2026-0001",
  supplierId: "sup-1",
  status: "DRAFT",
  billDate: new Date("2026-06-01"),
  items: [linkedItem()],
  supplier: { id: "sup-1", name: "Acme Foods" },
  ...overrides,
});

describe("VendorBillsService", () => {
  let service: VendorBillsService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VendorBillsService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
      ],
    }).compile();

    service = module.get<VendorBillsService>(VendorBillsService);
  });

  // ─── receive ────────────────────────────────────────────────────────────────

  describe("receive", () => {
    it("throws UNLINKED_ITEMS 409 for a bill with no line items", async () => {
      prisma.vendorBill.findUnique.mockResolvedValue(bill({ items: [] }));

      await expect(service.receive("bill-1")).rejects.toMatchObject({
        constructor: ConflictException,
        response: expect.objectContaining({ code: "UNLINKED_ITEMS" }),
      });
      expect(prisma.vendorBill.update).not.toHaveBeenCalled();
    });

    it("throws UNLINKED_ITEMS 409 listing partially-unlinked lines", async () => {
      prisma.vendorBill.findUnique.mockResolvedValue(
        bill({
          items: [
            linkedItem(),
            linkedItem({
              id: "item-2",
              productId: null,
              product: null,
              description: "Freight",
              qty: D(1),
              unitCost: D(25),
            }),
          ],
        }),
      );

      await expect(service.receive("bill-1")).rejects.toMatchObject({
        response: expect.objectContaining({
          code: "UNLINKED_ITEMS",
          unlinkedItems: [{ id: "item-2", description: "Freight", qty: 1, unitCost: 25 }],
        }),
      });
    });

    it("receives with acknowledgeUnlinked, syncing only the linked lines", async () => {
      prisma.vendorBill.findUnique.mockResolvedValueOnce(
        bill({
          items: [
            linkedItem(),
            linkedItem({ id: "item-2", productId: null, product: null, description: "Freight" }),
          ],
        }),
      );
      prisma.product.findUnique.mockResolvedValue({ currentStock: D(10), averageCost: D(2) });

      await service.receive("bill-1", { acknowledgeUnlinked: true }, "user-1");

      // One movement + one lot for the single linked line
      expect(prisma.stockMovement.create).toHaveBeenCalledTimes(1);
      expect(prisma.stockLot.create).toHaveBeenCalledTimes(1);
    });

    it("updates the weighted average, creates a StockLot, and stamps snapshots", async () => {
      prisma.vendorBill.findUnique.mockResolvedValueOnce(bill());
      prisma.product.findUnique.mockResolvedValue({ currentStock: D(10), averageCost: D(2) });

      await service.receive("bill-1", undefined, "user-1");

      // (10×2 + 5×3.5) / 15 = 2.5
      const movementArgs = prisma.stockMovement.create.mock.calls[0][0].data;
      expect(movementArgs.type).toBe("PURCHASE");
      expect(movementArgs.unitCost.toString()).toBe("3.5");
      expect(movementArgs.avgCostAfter.toString()).toBe("2.5");
      expect(movementArgs.stockAfter.toString()).toBe("15");
      expect(movementArgs.performedById).toBe("user-1");

      const lotArgs = prisma.stockLot.create.mock.calls[0][0].data;
      expect(lotArgs.reference).toBe("BILL-2026-0001");
      expect(lotArgs.remainingQty.toString()).toBe("5");
      expect(lotArgs.unitCost.toString()).toBe("3.5");

      const productArgs = prisma.product.update.mock.calls[0][0].data;
      expect(productArgs.averageCost.toString()).toBe("2.5");
    });

    it("still rejects double-receive (RF-084)", async () => {
      prisma.vendorBill.findUnique.mockResolvedValue(bill({ status: "RECEIVED" }));

      await expect(service.receive("bill-1")).rejects.toThrow("Bill already received");
    });
  });

  // ─── revertToDraft ──────────────────────────────────────────────────────────

  describe("revertToDraft", () => {
    it("restores the prior average exactly", async () => {
      // Product is at 15 @ 2.50 after receiving 5 @ 3.50 — reverting must yield 2.00
      prisma.vendorBill.findUnique.mockResolvedValue(bill({ status: "RECEIVED" }));
      prisma.product.findUnique.mockResolvedValue({ currentStock: D(15), averageCost: D(2.5) });
      prisma.stockLot.findMany.mockResolvedValue([]);

      await service.revertToDraft("bill-1");

      const productArgs = prisma.product.update.mock.calls[0][0].data;
      expect(productArgs.averageCost.toString()).toBe("2");
      expect(productArgs.currentStock).toEqual({ decrement: D(5) });
    });

    it("KEEPS the average when the revert empties stock (no more zeroing)", async () => {
      prisma.vendorBill.findUnique.mockResolvedValue(bill({ status: "RECEIVED" }));
      prisma.product.findUnique.mockResolvedValue({ currentStock: D(5), averageCost: D(3.5) });
      prisma.stockLot.findMany.mockResolvedValue([]);

      await service.revertToDraft("bill-1");

      const productArgs = prisma.product.update.mock.calls[0][0].data;
      expect(productArgs.averageCost).toBeUndefined();
      expect(productArgs.currentStock).toEqual({ decrement: D(5) });
    });

    it("deletes untouched lots and zeroes partially-consumed ones", async () => {
      prisma.vendorBill.findUnique.mockResolvedValue(bill({ status: "RECEIVED" }));
      prisma.product.findUnique.mockResolvedValue({ currentStock: D(15), averageCost: D(2.5) });
      prisma.stockLot.findMany.mockResolvedValue([
        { id: "lot-1", qty: D(5), remainingQty: D(5), notes: null },
        { id: "lot-2", qty: D(5), remainingQty: D(2), notes: null },
      ]);

      await service.revertToDraft("bill-1");

      expect(prisma.stockLot.delete).toHaveBeenCalledWith({ where: { id: "lot-1" } });
      expect(prisma.stockLot.update).toHaveBeenCalledWith({
        where: { id: "lot-2" },
        data: expect.objectContaining({ remainingQty: 0 }),
      });
    });
  });

  // ─── voidBill ───────────────────────────────────────────────────────────────

  describe("voidBill", () => {
    it("writes a costed compensating ADJUSTMENT with snapshots and keeps avg on stock-empty", async () => {
      prisma.vendorBill.findUnique.mockResolvedValue(bill({ status: "RECEIVED" }));
      prisma.product.findUnique.mockResolvedValue({ currentStock: D(5), averageCost: D(3.5) });
      prisma.stockLot.findMany.mockResolvedValue([]);

      await service.voidBill("bill-1", "user-1");

      const movementArgs = prisma.stockMovement.create.mock.calls[0][0].data;
      expect(movementArgs.type).toBe("ADJUSTMENT");
      expect(movementArgs.quantity.toString()).toBe("-5");
      expect(movementArgs.unitCost.toString()).toBe("3.5");
      // Reversal empties stock → average carried forward, not zeroed
      expect(movementArgs.avgCostAfter.toString()).toBe("3.5");
      expect(movementArgs.stockAfter.toString()).toBe("0");
      expect(movementArgs.performedById).toBe("user-1");

      const productArgs = prisma.product.update.mock.calls[0][0].data;
      expect(productArgs.averageCost).toBeUndefined();
    });
  });

  // ─── findAll needsMapping ───────────────────────────────────────────────────

  describe("findAll", () => {
    it("always returns needsMappingCount in meta", async () => {
      prisma.vendorBill.findMany.mockResolvedValue([]);
      prisma.vendorBill.count.mockResolvedValueOnce(0).mockResolvedValueOnce(3);

      const result = await service.findAll();

      expect(result.meta.needsMappingCount).toBe(3);
      expect(prisma.vendorBill.count).toHaveBeenCalledWith({
        where: {
          status: "DRAFT",
          OR: [{ items: { none: {} } }, { items: { some: { productId: null } } }],
        },
      });
    });

    it("filters to DRAFT bills with missing/unlinked items when needsMapping is set", async () => {
      prisma.vendorBill.findMany.mockResolvedValue([]);

      await service.findAll(undefined, undefined, undefined, undefined, undefined, 1, 20, true);

      const where = prisma.vendorBill.findMany.mock.calls[0][0].where;
      expect(where.status).toBe("DRAFT");
      expect(where.AND).toEqual([
        { OR: [{ items: { none: {} } }, { items: { some: { productId: null } } }] },
      ]);
    });
  });
});
