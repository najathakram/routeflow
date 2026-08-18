import { Test, TestingModule } from "@nestjs/testing";
import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import { VendorBillsService } from "./vendor-bills.service";
import { PrismaService } from "../prisma/prisma.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { DuplicateMatchService } from "../import/duplicate-match.service";
import { ProductAliasService } from "../import/product-alias.service";
import { StorageService } from "../storage/storage.service";
import { InventoryService } from "../inventory/inventory.service";
import { createMockPrisma } from "../testing/prisma-mock";

const mockAnthropicCreate = jest.fn();
jest.mock("@anthropic-ai/sdk", () => ({
  __esModule: true,
  default: jest.fn(() => ({ messages: { create: mockAnthropicCreate } })),
}));

const mockSharpToBuffer = jest.fn();
jest.mock("sharp", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    rotate: jest.fn().mockReturnThis(),
    jpeg: jest.fn().mockReturnThis(),
    toBuffer: mockSharpToBuffer,
  })),
}));

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

/** An existing bill as the matcher reports it. */
const duplicateMatch = (overrides: Record<string, unknown> = {}) => ({
  id: "vb-9",
  billNumber: "BILL-2026-0009",
  status: "RECEIVED",
  totalOwed: 100,
  billDate: new Date("2026-06-01"),
  receivedDate: new Date("2026-06-02"),
  supplierId: "sup-1",
  itemCount: 4,
  matchedBy: "number" as const,
  totalMatches: true,
  ...overrides,
});

const dupMatch = {
  normalizeNumber: (raw: string) => (raw ?? "").toUpperCase().replace(/\s+/g, ""),
  findVendorBillDuplicate: jest.fn(),
  findScanDuplicate: jest.fn(),
};

const storage = {
  upload: jest.fn(),
  presignedUrl: jest.fn(),
};

const inventory = {
  recomputeProductInTx: jest.fn(),
  fireStockAlerts: jest.fn(),
};

/**
 * `createMockPrisma` predates InvoiceScan. Graft the model onto the very object
 * `forTenant()` hands back, so a tenant-scoped call and a direct one see the
 * same jest mocks.
 */
function graftInvoiceScan(prisma: ReturnType<typeof createMockPrisma>) {
  const model = {
    findFirst: jest.fn().mockResolvedValue(null),
    findUnique: jest.fn().mockResolvedValue(null),
    findMany: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockResolvedValue({ id: "scan-1" }),
    update: jest.fn().mockResolvedValue({}),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    count: jest.fn().mockResolvedValue(0),
  };
  (prisma as any).invoiceScan = model;
  (prisma.forTenant() as any).invoiceScan = model;
  return model;
}

describe("VendorBillsService", () => {
  let service: VendorBillsService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let invoiceScan: ReturnType<typeof graftInvoiceScan>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    invoiceScan = graftInvoiceScan(prisma);
    dupMatch.findVendorBillDuplicate.mockReset();
    dupMatch.findVendorBillDuplicate.mockResolvedValue(null);
    dupMatch.findScanDuplicate.mockReset();
    dupMatch.findScanDuplicate.mockResolvedValue(null);
    storage.upload.mockReset();
    storage.upload.mockImplementation((key: string) => Promise.resolve(key));
    storage.presignedUrl.mockReset();
    storage.presignedUrl.mockResolvedValue("https://files.test/scan");

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VendorBillsService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        { provide: DuplicateMatchService, useValue: dupMatch },
        { provide: StorageService, useValue: storage },
        { provide: InventoryService, useValue: inventory },
        // Real ProductAliasService (not a jest mock) wired against the same
        // prisma mock — so the alias tests below exercise its actual
        // resolve/resolveMany/learn/unlearn logic, not a stub.
        ProductAliasService,
      ],
    }).compile();
    inventory.recomputeProductInTx.mockReset();
    inventory.fireStockAlerts.mockReset();

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
      prisma.vendorBill.findUnique.mockResolvedValue(
        bill({ status: "RECEIVED", receivedDate: new Date("2026-06-02") }),
      );

      await expect(service.receive("bill-1")).rejects.toThrow("Bill already received");
    });

    it("G1: rejects receiving a PAID bill that was already received — status alone lies", async () => {
      // recordPayment overwrites status to PAID; the receipt marker is receivedDate.
      prisma.vendorBill.findUnique.mockResolvedValue(
        bill({ status: "PAID", receivedDate: new Date("2026-06-02") }),
      );

      await expect(service.receive("bill-1")).rejects.toThrow("Bill already received");
      expect(prisma.stockMovement.create).not.toHaveBeenCalled();
    });

    it("G2: converts a case-priced line (packSize) to pieces + per-piece cost", async () => {
      // 2 cases of 6 @ $12/case → 12 pieces @ $2/piece.
      prisma.vendorBill.findUnique.mockResolvedValueOnce(
        bill({ items: [linkedItem({ qty: D(2), unitCost: D(12), packSize: 6 })] }),
      );
      prisma.product.findUnique.mockResolvedValue({
        currentStock: D(0),
        averageCost: null,
        costingMethod: "AVCO",
      });

      await service.receive("bill-1", undefined, "user-1");

      const movementArgs = prisma.stockMovement.create.mock.calls[0][0].data;
      expect(movementArgs.quantity.toString()).toBe("12");
      expect(movementArgs.unitCost.toString()).toBe("2");
      expect(movementArgs.avgCostAfter.toString()).toBe("2");
      const lotArgs = prisma.stockLot.create.mock.calls[0][0].data;
      expect(lotArgs.qty.toString()).toBe("12");
      expect(lotArgs.unitCost.toString()).toBe("2");
      const productArgs = prisma.product.update.mock.calls[0][0].data;
      expect(productArgs.currentStock).toEqual({ increment: movementArgs.quantity });
      expect(productArgs.averageCost.toString()).toBe("2");
    });

    it("G7: a STANDARD product keeps its cost — averageCost untouched by receive", async () => {
      prisma.vendorBill.findUnique.mockResolvedValueOnce(bill());
      prisma.product.findUnique.mockResolvedValue({
        currentStock: D(10),
        averageCost: D(2),
        costingMethod: "STANDARD",
      });

      await service.receive("bill-1", undefined, "user-1");

      const productArgs = prisma.product.update.mock.calls[0][0].data;
      expect(productArgs.averageCost).toBeUndefined();
      const movementArgs = prisma.stockMovement.create.mock.calls[0][0].data;
      expect(movementArgs.avgCostAfter.toString()).toBe("2"); // snapshot of the kept average
    });

    it("G7: stamps the PURCHASE movement at the bill date (matching the lot)", async () => {
      prisma.vendorBill.findUnique.mockResolvedValueOnce(bill());
      prisma.product.findUnique.mockResolvedValue({ currentStock: D(10), averageCost: D(2) });

      await service.receive("bill-1", undefined, "user-1");

      const movementArgs = prisma.stockMovement.create.mock.calls[0][0].data;
      expect(movementArgs.createdAt).toEqual(new Date("2026-06-01"));
      const lotArgs = prisma.stockLot.create.mock.calls[0][0].data;
      expect(lotArgs.purchaseDate).toEqual(new Date("2026-06-01"));
    });

    it("G7: a backdated bill with later movements triggers the replay repair", async () => {
      prisma.vendorBill.findUnique.mockResolvedValueOnce(bill());
      prisma.product.findUnique.mockResolvedValue({ currentStock: D(10), averageCost: D(2) });
      prisma.stockMovement.count.mockResolvedValue(3); // newer movements exist

      await service.receive("bill-1", undefined, "user-1");

      expect(inventory.recomputeProductInTx).toHaveBeenCalledWith(expect.anything(), "prod-1");
      expect(inventory.fireStockAlerts).toHaveBeenCalledWith(["prod-1"]);
    });

    it("G3: partial receive applies only the requested quantity and marks PARTIAL", async () => {
      // 2 of 5 cases (pack 6) arrive: 12 pieces @ $2/piece; the line records 2.
      prisma.vendorBill.findUnique.mockResolvedValueOnce(
        bill({
          items: [linkedItem({ qty: D(5), unitCost: D(12), packSize: 6, qtyReceived: null })],
        }),
      );
      prisma.product.findUnique.mockResolvedValue({ currentStock: D(0), averageCost: null });

      await service.receive("bill-1", { items: [{ itemId: "item-1", qty: 2 }] }, "user-1");

      const movementArgs = prisma.stockMovement.create.mock.calls[0][0].data;
      expect(movementArgs.quantity.toString()).toBe("12");
      expect(movementArgs.unitCost.toString()).toBe("2");
      const billArgs = prisma.vendorBill.update.mock.calls[0][0].data;
      expect(billArgs.status).toBe("PARTIAL");
      expect(billArgs.receivedDate).toBeInstanceOf(Date);
      // Nested through the parent — items have null tenantId (nested create),
      // so a direct scoped vendorBillItem.update would miss them.
      expect(billArgs.items.update).toEqual([
        { where: { id: "item-1" }, data: { qtyReceived: D("2") } },
      ]);
    });

    it("G3: a top-up receives the remainder, completes the bill, and keeps the first receipt date", async () => {
      const firstReceipt = new Date("2026-06-02");
      prisma.vendorBill.findUnique.mockResolvedValueOnce(
        bill({
          status: "PARTIAL",
          receivedDate: firstReceipt,
          items: [linkedItem({ qty: D(10), qtyReceived: D(4) })],
        }),
      );
      prisma.product.findUnique.mockResolvedValue({ currentStock: D(4), averageCost: D(3.5) });

      await service.receive("bill-1", undefined, "user-1");

      const movementArgs = prisma.stockMovement.create.mock.calls[0][0].data;
      expect(movementArgs.quantity.toString()).toBe("6");
      const billArgs = prisma.vendorBill.update.mock.calls[0][0].data;
      expect(billArgs.status).toBe("RECEIVED");
      expect(billArgs.receivedDate).toBe(firstReceipt);
      expect(billArgs.items.update).toEqual([
        { where: { id: "item-1" }, data: { qtyReceived: D("10") } },
      ]);
    });

    it("G3: rejects receiving more than the outstanding quantity", async () => {
      prisma.vendorBill.findUnique.mockResolvedValue(
        bill({
          status: "PARTIAL",
          receivedDate: new Date("2026-06-02"),
          items: [linkedItem({ qty: D(10), qtyReceived: D(4) })],
        }),
      );

      await expect(
        service.receive("bill-1", { items: [{ itemId: "item-1", qty: 7 }] }),
      ).rejects.toThrow(/exceeds the 6/);
      expect(prisma.stockMovement.create).not.toHaveBeenCalled();
    });

    it("G3: a fully-topped-up bill rejects another receive", async () => {
      prisma.vendorBill.findUnique.mockResolvedValue(
        bill({
          status: "RECEIVED",
          receivedDate: new Date("2026-06-02"),
          items: [linkedItem({ qty: D(10), qtyReceived: D(10) })],
        }),
      );

      await expect(service.receive("bill-1")).rejects.toThrow("Bill already received");
    });
  });

  // ─── revertToDraft ──────────────────────────────────────────────────────────

  describe("revertToDraft", () => {
    it("restores the prior average exactly", async () => {
      // Product is at 15 @ 2.50 after receiving 5 @ 3.50 — reverting must yield 2.00
      prisma.vendorBill.findUnique.mockResolvedValue(
        bill({ status: "RECEIVED", receivedDate: new Date("2026-06-02") }),
      );
      prisma.product.findUnique.mockResolvedValue({ currentStock: D(15), averageCost: D(2.5) });
      prisma.stockLot.findMany.mockResolvedValue([]);

      await service.revertToDraft("bill-1");

      const productArgs = prisma.product.update.mock.calls[0][0].data;
      expect(productArgs.averageCost.toString()).toBe("2");
      expect(productArgs.currentStock).toEqual({ decrement: D(5) });
    });

    it("KEEPS the average when the revert empties stock (no more zeroing)", async () => {
      prisma.vendorBill.findUnique.mockResolvedValue(
        bill({ status: "RECEIVED", receivedDate: new Date("2026-06-02") }),
      );
      prisma.product.findUnique.mockResolvedValue({ currentStock: D(5), averageCost: D(3.5) });
      prisma.stockLot.findMany.mockResolvedValue([]);

      await service.revertToDraft("bill-1");

      const productArgs = prisma.product.update.mock.calls[0][0].data;
      expect(productArgs.averageCost).toBeUndefined();
      expect(productArgs.currentStock).toEqual({ decrement: D(5) });
    });

    it("deletes untouched lots and zeroes partially-consumed ones", async () => {
      prisma.vendorBill.findUnique.mockResolvedValue(
        bill({ status: "RECEIVED", receivedDate: new Date("2026-06-02") }),
      );
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

    it("G1: refuses to revert a PARTIAL bill that was never received (payment-only status)", async () => {
      // recordPayment can set PARTIAL on a DRAFT bill; reversing would drain
      // stock that was never added.
      prisma.vendorBill.findUnique.mockResolvedValue(
        bill({ status: "PARTIAL", receivedDate: null }),
      );

      await expect(service.revertToDraft("bill-1")).rejects.toThrow("never received");
      expect(prisma.product.update).not.toHaveBeenCalled();
      expect(prisma.stockMovement.deleteMany).not.toHaveBeenCalled();
    });

    it("G2: reverses a case-priced line in the SAME converted denomination", async () => {
      // Received as 12 pieces (2 cases × 6); revert must decrement 12, not 2.
      prisma.vendorBill.findUnique.mockResolvedValue(
        bill({
          status: "RECEIVED",
          receivedDate: new Date("2026-06-02"),
          items: [linkedItem({ qty: D(2), unitCost: D(12), packSize: 6 })],
        }),
      );
      prisma.product.findUnique.mockResolvedValue({ currentStock: D(12), averageCost: D(2) });
      prisma.stockLot.findMany.mockResolvedValue([]);

      await service.revertToDraft("bill-1");

      const productArgs = prisma.product.update.mock.calls[0][0].data;
      expect(productArgs.currentStock).toEqual({ decrement: D(2).mul(6) });
    });

    it("G3: reverting a partially received bill reverses only what arrived", async () => {
      // 4 of 10 received — the revert must decrement 4, not 10, and clear the tracking.
      prisma.vendorBill.findUnique.mockResolvedValue(
        bill({
          status: "PARTIAL",
          receivedDate: new Date("2026-06-02"),
          items: [linkedItem({ qty: D(10), qtyReceived: D(4) })],
        }),
      );
      prisma.product.findUnique.mockResolvedValue({ currentStock: D(14), averageCost: D(2.5) });
      prisma.stockLot.findMany.mockResolvedValue([]);

      await service.revertToDraft("bill-1");

      const productArgs = prisma.product.update.mock.calls[0][0].data;
      expect(productArgs.currentStock).toEqual({ decrement: D("4") });
      const billArgs = prisma.vendorBill.update.mock.calls[0][0].data;
      expect(billArgs.items).toEqual({
        updateMany: { where: {}, data: { qtyReceived: null } },
      });
    });
  });

  // ─── voidBill ───────────────────────────────────────────────────────────────

  describe("voidBill", () => {
    it("writes a costed compensating ADJUSTMENT with snapshots and keeps avg on stock-empty", async () => {
      prisma.vendorBill.findUnique.mockResolvedValue(
        bill({ status: "RECEIVED", receivedDate: new Date("2026-06-02") }),
      );
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

    it("G1: voiding a PAID-but-never-received bill skips the stock reversal", async () => {
      prisma.vendorBill.findUnique.mockResolvedValue(bill({ status: "PAID", receivedDate: null }));

      await service.voidBill("bill-1", "user-1");

      expect(prisma.stockMovement.create).not.toHaveBeenCalled();
      expect(prisma.product.update).not.toHaveBeenCalled();
      // The bill itself still gets voided.
      expect(prisma.vendorBill.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "VOID" }) }),
      );
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

  // ─── create ─────────────────────────────────────────────────────────────────

  describe("create", () => {
    beforeEach(() => {
      prisma.vendorBill.findFirst.mockResolvedValue(null); // nextBillNumber
      prisma.vendorBill.create.mockResolvedValue(bill());
    });

    it("rounds totalOwed computed from items (no float artifacts)", async () => {
      await service.create({
        requireSupplier: false,
        items: [
          { description: "A", qty: 3, unitCost: 0.1 },
          { description: "B", qty: 1, unitCost: 0.2 },
        ],
      });

      // 3×0.1 + 0.2 = 0.5000000000000001 unrounded — must be written as 0.5
      const data = prisma.vendorBill.create.mock.calls[0][0].data;
      expect(data.totalOwed).toBe(0.5);
    });

    it("folds taxAmount into totalOwed (scanned supplier invoices carry sales tax)", async () => {
      await service.create({
        requireSupplier: false,
        taxAmount: 5.999,
        items: [{ description: "A", qty: 3, unitCost: 1.4849 }],
      });

      // 3×1.4849 = 4.4547; + 5.999 = 10.4537 → rounded to cents
      const data = prisma.vendorBill.create.mock.calls[0][0].data;
      expect(data.totalOwed).toBe(10.45);
    });

    it("ignores a missing/garbage taxAmount", async () => {
      await service.create({
        requireSupplier: false,
        taxAmount: "not-a-number",
        items: [{ description: "A", qty: 2, unitCost: 10 }],
      });

      const data = prisma.vendorBill.create.mock.calls[0][0].data;
      expect(data.totalOwed).toBe(20);
    });

    it("persists tax and subtotal as rounded columns without changing totalOwed", async () => {
      await service.create({
        requireSupplier: false,
        taxAmount: 5.999,
        subtotal: 4.4547,
        items: [{ description: "A", qty: 3, unitCost: 1.4849 }],
      });

      const data = prisma.vendorBill.create.mock.calls[0][0].data;
      expect(data.totalOwed).toBe(10.45);
      expect(data.taxAmount.toString()).toBe("6");
      expect(data.subtotal.toString()).toBe("4.45");
    });

    it("leaves tax and subtotal null rather than zero when the client sent neither", async () => {
      await service.create({
        requireSupplier: false,
        items: [{ description: "A", qty: 1, unitCost: 10 }],
      });

      const data = prisma.vendorBill.create.mock.calls[0][0].data;
      expect(data.taxAmount).toBeNull();
      expect(data.subtotal).toBeNull();
    });

    it("keeps the per-line sku, packSize and lineTotal the scan read", async () => {
      await service.create({
        requireSupplier: false,
        items: [
          { description: "A", qty: 2, unitCost: 3.5, sku: "AB-12", packSize: 24, lineTotal: 7 },
          { description: "B", qty: 1, unitCost: 4 },
        ],
      });

      const items = prisma.vendorBill.create.mock.calls[0][0].data.items.createMany.data;
      expect(items[0]).toMatchObject({ sku: "AB-12", packSize: 24 });
      expect(items[0].lineTotal.toString()).toBe("7");
      expect(items[1]).toMatchObject({ sku: null, packSize: null, lineTotal: null });
    });

    it("marks the originating scan POSTED and links it to the new bill", async () => {
      prisma.vendorBill.create.mockResolvedValue(bill({ id: "bill-77" }));

      await service.create({
        requireSupplier: false,
        scanId: "scan-5",
        items: [{ description: "A", qty: 1, unitCost: 10 }],
      });

      expect(invoiceScan.updateMany).toHaveBeenCalledWith({
        where: { id: "scan-5" },
        data: { status: "POSTED", vendorBillId: "bill-77" },
      });
    });

    it("still returns the bill when the scan link fails — the bill is already written", async () => {
      invoiceScan.updateMany.mockRejectedValue(new Error("scan gone"));

      await expect(
        service.create({
          requireSupplier: false,
          scanId: "scan-5",
          items: [{ description: "A", qty: 1, unitCost: 10 }],
        }),
      ).resolves.toMatchObject({ id: "bill-1" });
    });
  });

  // ─── duplicate guard ────────────────────────────────────────────────────────

  describe("create — duplicate guard", () => {
    beforeEach(() => {
      prisma.vendorBill.findFirst.mockResolvedValue(null); // nextBillNumber
      prisma.vendorBill.create.mockResolvedValue(bill());
      prisma.supplier.findUnique.mockResolvedValue({ name: "Acme Foods" });
    });

    const scanned = (overrides: Record<string, unknown> = {}) => ({
      requireSupplier: false,
      supplierInvoiceNumber: "INV-1",
      items: [{ description: "A", qty: 1, unitCost: 100 }],
      ...overrides,
    });

    it("blocks a re-scan of the same supplier invoice with a structured 409", async () => {
      dupMatch.findVendorBillDuplicate.mockResolvedValue(duplicateMatch());

      await expect(service.create(scanned())).rejects.toMatchObject({
        constructor: ConflictException,
        response: expect.objectContaining({
          code: "DUPLICATE_VENDOR_BILL",
          duplicate: expect.objectContaining({
            billId: "vb-9",
            billNumber: "BILL-2026-0009",
            resumable: false,
            supplierName: "Acme Foods",
            itemCount: 4,
            matchedBy: "number",
            totalMatches: true,
          }),
        }),
      });
      expect(prisma.vendorBill.create).not.toHaveBeenCalled();
    });

    it("writes a message that stands alone for clients that only surface the text", async () => {
      dupMatch.findVendorBillDuplicate.mockResolvedValue(duplicateMatch());

      const err = await service.create(scanned()).catch((e) => e);
      const message = err.response.message as string;
      expect(message).toContain("INV-1");
      expect(message).toContain("BILL-2026-0009");
      expect(message).toContain("double stock");
    });

    it("points a DRAFT match at finishing the existing bill instead of a second one", async () => {
      dupMatch.findVendorBillDuplicate.mockResolvedValue(duplicateMatch({ status: "DRAFT" }));

      const err = await service.create(scanned()).catch((e) => e);
      expect(err.response.duplicate.resumable).toBe(true);
      expect(err.response.message).toContain("open it to finish receiving");
    });

    it("records the bill on a FUZZY match — same supplier, day and amount isn't identity", async () => {
      dupMatch.findVendorBillDuplicate.mockResolvedValue(duplicateMatch({ matchedBy: "fuzzy" }));

      await service.create({
        supplierId: "sup-1",
        billDate: "2026-06-01",
        items: [{ description: "A", qty: 1, unitCost: 100 }],
      });

      expect(dupMatch.findVendorBillDuplicate).toHaveBeenCalled();
      expect(prisma.vendorBill.create).toHaveBeenCalled();
    });

    it("records the bill anyway when the operator sends allowDuplicate", async () => {
      dupMatch.findVendorBillDuplicate.mockResolvedValue(duplicateMatch());

      await service.create(scanned({ allowDuplicate: true }));

      expect(dupMatch.findVendorBillDuplicate).not.toHaveBeenCalled();
      expect(dupMatch.findScanDuplicate).not.toHaveBeenCalled();
      expect(prisma.vendorBill.create).toHaveBeenCalled();
    });

    // ── lineFingerprint: the layer that covers bills whose number was never legible
    describe("line-fingerprint match", () => {
      /** A posted scan of the same numbers, and the bill it became. */
      const postedElsewhere = (billOverrides: Record<string, unknown> = {}) => {
        invoiceScan.findUnique.mockResolvedValue({ lineFingerprint: "fp-abc" });
        dupMatch.findScanDuplicate.mockResolvedValue({
          id: "scan-old",
          status: "POSTED",
          createdAt: new Date("2026-08-01"),
          vendorBillId: "vb-9",
          supplierInvoiceNumber: null,
          total: 100,
          matchedBy: "lines",
        });
        prisma.vendorBill.findUnique.mockResolvedValue({
          id: "vb-9",
          billNumber: "BILL-2026-0009",
          status: "RECEIVED",
          totalOwed: 100,
          billDate: new Date("2026-06-01"),
          receivedDate: new Date("2026-06-02"),
          supplierId: "sup-1",
          _count: { items: 4 },
          ...billOverrides,
        });
      };

      const numberless = (overrides: Record<string, unknown> = {}) => ({
        requireSupplier: false,
        scanId: "scan-new",
        items: [{ description: "A", qty: 1, unitCost: 100 }],
        ...overrides,
      });

      it("blocks the create with the same 409 an invoice-number match throws", async () => {
        postedElsewhere();

        await expect(service.create(numberless())).rejects.toMatchObject({
          constructor: ConflictException,
          response: expect.objectContaining({
            code: "DUPLICATE_VENDOR_BILL",
            duplicate: expect.objectContaining({
              billId: "vb-9",
              billNumber: "BILL-2026-0009",
              matchedBy: "lines",
              totalMatches: true,
            }),
          }),
        });
        expect(prisma.vendorBill.create).not.toHaveBeenCalled();
      });

      it("explains the block without an invoice number to name", async () => {
        postedElsewhere();

        const err = await service.create(numberless()).catch((e) => e);
        expect(err.response.message).toContain("identical quantities and unit costs");
        expect(err.response.message).toContain("BILL-2026-0009");
      });

      it("compares the scan's OWN stored fingerprint, not one recomputed from the lines", async () => {
        postedElsewhere();

        await service.create(numberless()).catch(() => undefined);

        expect(dupMatch.findScanDuplicate).toHaveBeenCalledWith({
          lineFingerprint: "fp-abc",
          supplierId: null, // this fixture resolves no supplier; the lookup still runs
        });
      });

      it("records the bill when the matching scan was never posted", async () => {
        postedElsewhere();
        dupMatch.findScanDuplicate.mockResolvedValue({
          id: "scan-old",
          status: "SCANNED",
          createdAt: new Date("2026-08-01"),
          vendorBillId: null,
          supplierInvoiceNumber: null,
          total: 100,
          matchedBy: "lines",
        });

        await service.create(numberless());

        expect(prisma.vendorBill.create).toHaveBeenCalled();
      });

      it("records the bill when the matched scan's bill was voided", async () => {
        postedElsewhere({ status: "VOID" });

        await service.create(numberless());

        expect(prisma.vendorBill.create).toHaveBeenCalled();
      });

      it("does not block a re-post of the very scan being posted", async () => {
        postedElsewhere();
        dupMatch.findScanDuplicate.mockResolvedValue({
          id: "scan-new",
          status: "POSTED",
          createdAt: new Date("2026-08-01"),
          vendorBillId: "vb-9",
          supplierInvoiceNumber: null,
          total: 100,
          matchedBy: "lines",
        });

        await service.create(numberless());

        expect(prisma.vendorBill.create).toHaveBeenCalled();
      });

      it("falls back to the lines in hand when the bill was keyed without a scan", async () => {
        await service.create({
          requireSupplier: false,
          items: [{ description: "A", qty: 2, unitCost: 5 }],
        });

        expect(invoiceScan.findUnique).not.toHaveBeenCalled();
        const [args] = dupMatch.findScanDuplicate.mock.calls[0];
        expect(args.lineFingerprint).toMatch(/^[0-9a-f]{64}$/);
      });

      it("skips the lookup entirely when the lines carry no usable numbers", async () => {
        await service.create({ requireSupplier: false, totalOwed: 50, items: [] });

        expect(dupMatch.findScanDuplicate).not.toHaveBeenCalled();
        expect(prisma.vendorBill.create).toHaveBeenCalled();
      });
    });

    it("records the bill when nothing live matches (a VOID prior bill never does)", async () => {
      dupMatch.findVendorBillDuplicate.mockResolvedValue(null);

      await service.create(scanned());

      expect(prisma.vendorBill.create).toHaveBeenCalled();
    });

    it("persists the supplier invoice number normalized", async () => {
      await service.create(scanned({ supplierInvoiceNumber: "inv 088 41" }));

      expect(prisma.vendorBill.create.mock.calls[0][0].data.supplierInvoiceNumber).toBe("INV08841");
      expect(dupMatch.findVendorBillDuplicate).toHaveBeenCalledWith(
        expect.objectContaining({ number: "INV08841" }),
      );
    });

    it("falls back to the notes phrase when only notes carry the number", async () => {
      await service.create({
        requireSupplier: false,
        notes: "Batch import — Supplier invoice #VB-7",
        items: [{ description: "A", qty: 1, unitCost: 10 }],
      });

      expect(prisma.vendorBill.create.mock.calls[0][0].data.supplierInvoiceNumber).toBe("VB-7");
      expect(dupMatch.findVendorBillDuplicate).toHaveBeenCalledWith(
        expect.objectContaining({ number: "VB-7" }),
      );
    });

    it.each([
      ["neither a number nor a supplier", { requireSupplier: false }],
      ["a supplier but no bill date", { supplierId: "sup-1" }],
    ])("skips the check with %s — nothing identifies the document", async (_label, extra) => {
      await service.create({ items: [{ description: "A", qty: 1, unitCost: 10 }], ...extra });

      expect(dupMatch.findVendorBillDuplicate).not.toHaveBeenCalled();
      expect(prisma.vendorBill.create).toHaveBeenCalled();
    });

    it("checks on supplier + bill date even with no number at all", async () => {
      await service.create({
        supplierId: "sup-1",
        billDate: "2026-06-01",
        items: [{ description: "A", qty: 1, unitCost: 10 }],
      });

      expect(dupMatch.findVendorBillDuplicate).toHaveBeenCalledWith({
        supplierId: "sup-1",
        number: null,
        total: 10,
        issueDate: new Date("2026-06-01"),
      });
    });
  });

  // ─── checkDuplicate ─────────────────────────────────────────────────────────

  describe("checkDuplicate", () => {
    it("maps a match to the wire payload, resolving the supplier name", async () => {
      dupMatch.findVendorBillDuplicate.mockResolvedValue(duplicateMatch({ status: "DRAFT" }));
      prisma.supplier.findUnique.mockResolvedValue({ name: "Acme Foods" });

      await expect(
        service.checkDuplicate({ supplierInvoiceNumber: "inv-1", total: 100 }),
      ).resolves.toEqual({
        duplicate: {
          billId: "vb-9",
          billNumber: "BILL-2026-0009",
          status: "DRAFT",
          resumable: true,
          totalOwed: 100,
          billDate: new Date("2026-06-01"),
          receivedDate: new Date("2026-06-02"),
          supplierName: "Acme Foods",
          itemCount: 4,
          matchedBy: "number",
          totalMatches: true,
        },
      });
    });

    it("returns null without querying when nothing identifies the document", async () => {
      await expect(service.checkDuplicate({ total: 100 })).resolves.toEqual({ duplicate: null });
      expect(dupMatch.findVendorBillDuplicate).not.toHaveBeenCalled();
    });

    it("still reports a fuzzy match so a client can warn before the operator commits", async () => {
      dupMatch.findVendorBillDuplicate.mockResolvedValue(duplicateMatch({ matchedBy: "fuzzy" }));
      prisma.supplier.findUnique.mockResolvedValue({ name: "Acme Foods" });

      await expect(
        service.checkDuplicate({ supplierId: "sup-1", billDate: "2026-06-01" }),
      ).resolves.toMatchObject({ duplicate: { billId: "vb-9", matchedBy: "fuzzy" } });
    });

    it("returns null when the matcher finds nothing", async () => {
      dupMatch.findVendorBillDuplicate.mockResolvedValue(null);

      await expect(
        service.checkDuplicate({ supplierId: "sup-1", billDate: "2026-06-01" }),
      ).resolves.toEqual({ duplicate: null });
    });
  });

  // ─── saveProductMapping ─────────────────────────────────────────────────────
  // ProductMapping's compound key (supplierName, rawDescription) has NO tenantId
  // — it is GLOBAL. These pin the tenant-safe findFirst→update/create rewrite
  // that replaced the old `upsert` (which could hit another tenant's row).

  describe("saveProductMapping", () => {
    it("updates the existing row by id for this tenant, without creating", async () => {
      prisma.productMapping.findFirst.mockResolvedValue({
        id: "map-1",
        supplierName: "Acme Foods",
        rawDescription: "flour 25lb",
        productId: "old-prod",
      });
      prisma.productMapping.update.mockResolvedValue({
        id: "map-1",
        supplierName: "Acme Foods",
        rawDescription: "flour 25lb",
        productId: "new-prod",
      });

      await expect(
        service.saveProductMapping("Acme Foods", "flour 25lb", "new-prod"),
      ).resolves.toEqual({
        id: "map-1",
        supplierName: "Acme Foods",
        rawDescription: "flour 25lb",
        productId: "new-prod",
      });
      expect(prisma.productMapping.findFirst).toHaveBeenCalledWith({
        where: { supplierName: "Acme Foods", rawDescription: "flour 25lb" },
      });
      expect(prisma.productMapping.update).toHaveBeenCalledWith({
        where: { id: "map-1" },
        data: { productId: "new-prod" },
      });
      expect(prisma.productMapping.create).not.toHaveBeenCalled();
    });

    it("creates a new row when this tenant has no existing mapping", async () => {
      prisma.productMapping.findFirst.mockResolvedValue(null);
      prisma.productMapping.create.mockResolvedValue({
        id: "map-2",
        supplierName: "Acme Foods",
        rawDescription: "sugar 10lb",
        productId: "prod-9",
      });

      await expect(
        service.saveProductMapping("Acme Foods", "sugar 10lb", "prod-9"),
      ).resolves.toEqual({
        id: "map-2",
        supplierName: "Acme Foods",
        rawDescription: "sugar 10lb",
        productId: "prod-9",
      });
      expect(prisma.productMapping.create).toHaveBeenCalledWith({
        data: { supplierName: "Acme Foods", rawDescription: "sugar 10lb", productId: "prod-9" },
      });
      expect(prisma.productMapping.update).not.toHaveBeenCalled();
    });

    it("swallows a P2002 on create — another tenant already holds the global key", async () => {
      prisma.productMapping.findFirst.mockResolvedValue(null);
      prisma.productMapping.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
          code: "P2002",
          clientVersion: "7.8.0",
        }),
      );

      await expect(
        service.saveProductMapping("Acme Foods", "sugar 10lb", "prod-9"),
      ).resolves.toBeNull();
    });

    it("rejects a missing rawDescription instead of matching an unrelated row", async () => {
      // Prisma drops `undefined` filter keys — without the guard this would
      // findFirst on supplierName alone and repoint someone else's mapping.
      await expect(
        service.saveProductMapping("Acme Foods", undefined as unknown as string, "prod-9"),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.productMapping.findFirst).not.toHaveBeenCalled();
      expect(prisma.productMapping.update).not.toHaveBeenCalled();
      expect(prisma.productMapping.create).not.toHaveBeenCalled();
    });

    it("rethrows a non-P2002 error from create", async () => {
      prisma.productMapping.findFirst.mockResolvedValue(null);
      prisma.productMapping.create.mockRejectedValue(new Error("db is down"));

      await expect(
        service.saveProductMapping("Acme Foods", "sugar 10lb", "prod-9"),
      ).rejects.toThrow("db is down");
    });

    // ── alias dual-write (2026-08-18: scanner match memory) ──────────────────
    describe("alias dual-write", () => {
      it("does not learn a ProductAlias when the supplier name does not resolve", async () => {
        prisma.supplier.findMany.mockResolvedValue([]); // no active supplier named "Acme Foods"
        prisma.productMapping.findFirst.mockResolvedValue(null);
        prisma.productMapping.create.mockResolvedValue({
          id: "map-2",
          supplierName: "Acme Foods",
          rawDescription: "sugar 10lb",
          productId: "prod-9",
        });

        await service.saveProductMapping("Acme Foods", "sugar 10lb", "prod-9");

        expect(prisma.productAlias.upsert).not.toHaveBeenCalled();
        expect(prisma.productAlias.deleteMany).not.toHaveBeenCalled();
      });

      it("learns a supplier-scoped ProductAlias once the supplier name resolves", async () => {
        prisma.supplier.findMany.mockResolvedValue([{ id: "sup-1", name: "Acme Foods" }]);
        prisma.productMapping.findFirst.mockResolvedValue(null);
        prisma.productMapping.create.mockResolvedValue({
          id: "map-2",
          supplierName: "Acme Foods",
          rawDescription: "sugar 10lb",
          productId: "prod-9",
        });

        await service.saveProductMapping("Acme Foods", "sugar 10lb", "prod-9");

        expect(prisma.productAlias.upsert).toHaveBeenCalledWith(
          expect.objectContaining({
            where: {
              tenantId_supplierId_rawText: {
                tenantId: "test-tenant",
                supplierId: "sup-1",
                rawText: "SUGAR 10LB",
              },
            },
            create: expect.objectContaining({
              supplierId: "sup-1",
              rawText: "SUGAR 10LB",
              productId: "prod-9",
            }),
          }),
        );
        // Never the "" any-supplier scope from this flow.
        expect(prisma.productAlias.upsert).not.toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              tenantId_supplierId_rawText: expect.objectContaining({ supplierId: "" }),
            }),
          }),
        );
      });

      it("unlearns BOTH the supplier-scoped and any-supplier alias rows when a match is cleared", async () => {
        prisma.supplier.findMany.mockResolvedValue([{ id: "sup-1", name: "Acme Foods" }]);
        prisma.productMapping.findFirst.mockResolvedValue({
          id: "map-1",
          supplierName: "Acme Foods",
          rawDescription: "sugar 10lb",
          productId: "prod-9",
        });
        prisma.productMapping.update.mockResolvedValue({
          id: "map-1",
          supplierName: "Acme Foods",
          rawDescription: "sugar 10lb",
          productId: null,
        });
        prisma.productAlias.deleteMany.mockResolvedValue({ count: 2 });

        await service.saveProductMapping("Acme Foods", "sugar 10lb", null);

        expect(prisma.productAlias.deleteMany).toHaveBeenCalledWith({
          where: {
            tenantId: "test-tenant",
            rawText: "SUGAR 10LB",
            supplierId: { in: ["sup-1", ""] },
          },
        });
        expect(prisma.productAlias.upsert).not.toHaveBeenCalled();
      });
    });
  });

  // ─── scanInvoice ────────────────────────────────────────────────────────────

  describe("scanInvoice", () => {
    const jpegPage = { buffer: Buffer.from("img"), mimeType: "image/jpeg" };

    beforeEach(async () => {
      // Provide an API key so the scan reaches the Anthropic call.
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          VendorBillsService,
          { provide: PrismaService, useValue: prisma },
          { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue("test-key") } },
          { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
          { provide: DuplicateMatchService, useValue: dupMatch },
          { provide: StorageService, useValue: storage },
          { provide: InventoryService, useValue: inventory },
          ProductAliasService,
        ],
      }).compile();
      service = module.get<VendorBillsService>(VendorBillsService);
      mockAnthropicCreate.mockReset();
      mockSharpToBuffer.mockReset();
      prisma.product.findMany.mockResolvedValue([]);
      prisma.productMapping.findMany.mockResolvedValue([]);
      prisma.productAlias.findMany.mockResolvedValue([]);
      prisma.supplier.findMany.mockResolvedValue([]);
    });

    it("maps an Anthropic auth failure to a typed AI_KEY_INVALID 400 (not an opaque 500)", async () => {
      mockAnthropicCreate.mockRejectedValue({ status: 401 });

      await expect(service.scanInvoice([jpegPage])).rejects.toMatchObject({
        constructor: BadRequestException,
        response: expect.objectContaining({ code: "AI_KEY_INVALID" }),
      });
    });

    it("maps Anthropic overload/rate-limit to AI_UNAVAILABLE 503", async () => {
      mockAnthropicCreate.mockRejectedValue({ status: 529 });

      await expect(service.scanInvoice([jpegPage])).rejects.toMatchObject({
        constructor: ServiceUnavailableException,
        response: expect.objectContaining({ code: "AI_UNAVAILABLE" }),
      });
    });

    it("maps a non-transient Anthropic 4xx (e.g. a rejected/corrupt image) to AI_SCAN_REJECTED 400, not AI_UNAVAILABLE", async () => {
      mockAnthropicCreate.mockRejectedValue({ status: 400 });

      await expect(service.scanInvoice([jpegPage])).rejects.toMatchObject({
        constructor: BadRequestException,
        response: expect.objectContaining({ code: "AI_SCAN_REJECTED" }),
      });
    });

    it("keeps a 429 rate-limit mapped to the retryable AI_UNAVAILABLE, not AI_SCAN_REJECTED", async () => {
      mockAnthropicCreate.mockRejectedValue({ status: 429 });

      await expect(service.scanInvoice([jpegPage])).rejects.toMatchObject({
        constructor: ServiceUnavailableException,
        response: expect.objectContaining({ code: "AI_UNAVAILABLE" }),
      });
    });

    it("maps an unparseable AI response to AI_PARSE_FAILED 422", async () => {
      mockAnthropicCreate.mockResolvedValue({
        content: [{ type: "text", text: "sorry, no JSON here" }],
      });

      await expect(service.scanInvoice([jpegPage])).rejects.toMatchObject({
        constructor: UnprocessableEntityException,
        response: expect.objectContaining({ code: "AI_PARSE_FAILED" }),
      });
    });

    it("skips an unreadable HEIC page and discloses it in notes instead of failing the scan", async () => {
      mockSharpToBuffer.mockRejectedValue(new Error("bad heic"));
      mockAnthropicCreate.mockResolvedValue({
        content: [{ type: "text", text: JSON.stringify({ supplier: "Acme", items: [] }) }],
      });

      const result = await service.scanInvoice([
        jpegPage,
        { buffer: Buffer.from("heic"), mimeType: "image/heic" },
      ]);

      expect(result.notes).toMatch(/page 2 couldn't be read/i);
      // Only the readable page was sent to Claude.
      const content = mockAnthropicCreate.mock.calls[0][0].messages[0].content;
      expect(content.filter((b: { type: string }) => b.type === "image")).toHaveLength(1);
    });

    it("rejects when every page is unreadable", async () => {
      mockSharpToBuffer.mockRejectedValue(new Error("bad heic"));

      await expect(
        service.scanInvoice([{ buffer: Buffer.from("heic"), mimeType: "image/heic" }]),
      ).rejects.toThrow(/couldn't read any/i);
      expect(mockAnthropicCreate).not.toHaveBeenCalled();
    });

    it("does NOT auto-assign a weak (0.35-0.6) fuzzy match — line comes back unlinked with candidates", async () => {
      prisma.product.findMany.mockResolvedValue([
        {
          id: "prod-1",
          name: "Wheat Bread",
          sku: null,
          barcode: null,
          parentProductId: null,
          parent: null,
        },
      ]);
      mockAnthropicCreate.mockResolvedValue({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              supplier: "Acme Foods",
              items: [{ extractedName: "Wheat Bread Multigrain Extra", qty: 1, unitCost: 2.5 }],
            }),
          },
        ],
      });

      const result = await service.scanInvoice([jpegPage]);

      expect(result.items[0]).toMatchObject({
        matchedProductId: null,
        matchedProductName: null,
        confidence: "low",
      });
      expect(result.items[0].candidates?.length).toBeGreaterThan(0);
      expect(result.items[0].candidates[0]).toMatchObject({ productId: "prod-1" });
    });

    it("a learned product mapping wins over a competing exact-name catalog match and returns the composed name", async () => {
      prisma.productMapping.findMany.mockResolvedValue([
        {
          supplierName: "Acme Foods",
          rawDescription: "big red cinnamon gum",
          productId: "prod-9",
          product: {
            id: "prod-9",
            name: "Cinnamon",
            sku: null,
            barcode: null,
            parentProductId: "parent-1",
            parent: { name: "Big Red Chewing Gum" },
          },
        },
      ]);
      // A decoy catalog product that would otherwise win an EXACT name match —
      // the learned mapping must be checked first and take priority regardless.
      prisma.product.findMany.mockResolvedValue([
        {
          id: "prod-decoy",
          name: "Big Red Cinnamon Gum",
          sku: null,
          barcode: null,
          parentProductId: null,
          parent: null,
        },
      ]);
      mockAnthropicCreate.mockResolvedValue({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              supplier: "Acme Foods",
              items: [{ extractedName: "Big Red Cinnamon Gum", qty: 2, unitCost: 3 }],
            }),
          },
        ],
      });

      const result = await service.scanInvoice([jpegPage]);

      expect(result.items[0]).toMatchObject({
        matchedProductId: "prod-9",
        matchedProductName: "Big Red Chewing Gum - Cinnamon",
        confidence: "high",
      });
      expect(result.items[0].candidates).toBeUndefined();
    });

    // ── matching tiers + supplier resolution (2026-08-18: scanner memory) ────
    describe("scanner match memory", () => {
      it("a learned ProductAlias beats a competing legacy mapping AND a competing fuzzy catalog match", async () => {
        prisma.supplier.findMany.mockResolvedValue([{ id: "sup-1", name: "Acme Foods" }]);
        prisma.productAlias.findMany.mockResolvedValue([
          {
            rawText: "WIDGET",
            supplierId: "sup-1",
            productId: "prod-alias",
            expenseCategoryId: null,
          },
        ]);
        prisma.productMapping.findMany.mockResolvedValue([
          {
            supplierName: "Acme Foods",
            rawDescription: "widget",
            productId: "prod-mapping",
            product: {
              id: "prod-mapping",
              name: "Mapping Widget",
              sku: null,
              barcode: null,
              parentProductId: null,
              parent: null,
            },
          },
        ]);
        prisma.product.findMany.mockResolvedValue([
          {
            id: "prod-alias",
            name: "Alias Widget",
            sku: null,
            barcode: null,
            parentProductId: null,
            parent: null,
          },
          // Would win an EXACT-name fuzzy match if the alias/mapping tiers didn't run first.
          {
            id: "prod-fuzzy",
            name: "Widget",
            sku: null,
            barcode: null,
            parentProductId: null,
            parent: null,
          },
        ]);
        mockAnthropicCreate.mockResolvedValue({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                supplier: "Acme Foods",
                items: [{ extractedName: "Widget", qty: 1, unitCost: 5 }],
              }),
            },
          ],
        });

        const result = await service.scanInvoice([jpegPage]);

        expect(result.items[0]).toMatchObject({
          matchedProductId: "prod-alias",
          matchedProductName: "Alias Widget",
          confidence: "high",
          matchSource: "alias",
        });
        expect(result.supplierId).toBe("sup-1");
      });

      it("resolves supplierId server-side and persists it on InvoiceScan", async () => {
        prisma.supplier.findMany.mockResolvedValue([{ id: "sup-1", name: "Acme Foods" }]);
        mockAnthropicCreate.mockResolvedValue({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                supplier: "Acme Foods",
                items: [{ extractedName: "Widget", qty: 1, unitCost: 5 }],
              }),
            },
          ],
        });

        const result = await service.scanInvoice([jpegPage]);

        expect(result.supplierId).toBe("sup-1");
        expect(invoiceScan.create.mock.calls[0][0].data.supplierId).toBe("sup-1");
      });

      it("leaves supplierId null when the extracted supplier name doesn't resolve", async () => {
        prisma.supplier.findMany.mockResolvedValue([]);
        mockAnthropicCreate.mockResolvedValue({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                supplier: "Some Unknown Supplier",
                items: [{ extractedName: "Widget", qty: 1, unitCost: 5 }],
              }),
            },
          ],
        });

        const result = await service.scanInvoice([jpegPage]);

        expect(result.supplierId).toBeNull();
        expect(invoiceScan.create.mock.calls[0][0].data.supplierId).toBeNull();
      });
    });

    it("carries the per-line sku through from the OCR JSON to the response", async () => {
      mockAnthropicCreate.mockResolvedValue({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              supplier: "Acme Foods",
              items: [{ extractedName: "Widget", sku: "SKU-777", qty: 1, unitCost: 5 }],
            }),
          },
        ],
      });

      const result = await service.scanInvoice([jpegPage]);

      expect(result.items[0].sku).toBe("SKU-777");
    });

    it("carries the per-line packSize through from the OCR JSON to the response", async () => {
      mockAnthropicCreate.mockResolvedValue({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              supplier: "Acme Foods",
              items: [{ extractedName: "Widget", packSize: 12, qty: 1, unitCost: 5 }],
            }),
          },
        ],
      });

      const result = await service.scanInvoice([jpegPage]);

      expect(result.items[0].packSize).toBe(12);
    });

    it("leaves packSize null/absent when the OCR JSON doesn't include it", async () => {
      mockAnthropicCreate.mockResolvedValue({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              supplier: "Acme Foods",
              items: [{ extractedName: "Widget", qty: 1, unitCost: 5 }],
            }),
          },
        ],
      });

      const result = await service.scanInvoice([jpegPage]);

      expect(result.items[0].packSize).toBeUndefined();
    });

    // ── persistence: the scan and its AI spend must outlive an abandoned review
    describe("persistence", () => {
      const fullInvoice = {
        supplier: "Acme Foods",
        invoiceNumber: "inv 088 41",
        invoiceDate: "2026-08-01",
        subtotal: 100.005,
        tax: 8.25,
        total: 108.26,
        items: [
          { extractedName: "Widget", qty: 2, unitCost: 25 },
          { extractedName: "Gadget", qty: 1, unitCost: 50 },
        ],
      };

      const respondWith = (payload: Record<string, unknown>) =>
        mockAnthropicCreate.mockResolvedValue({
          content: [{ type: "text", text: JSON.stringify(payload) }],
        });

      it("records the scan with the promoted columns the duplicate keys are built from", async () => {
        respondWith(fullInvoice);

        const result = await service.scanInvoice([jpegPage], "user-7");

        const data = invoiceScan.create.mock.calls[0][0].data;
        expect(data.fileHash).toMatch(/^[0-9a-f]{64}$/);
        expect(data.lineFingerprint).toMatch(/^[0-9a-f]{64}$/);
        expect(data).toMatchObject({
          supplierNameRaw: "Acme Foods",
          supplierInvoiceNumber: "INV08841",
          lineCount: 2,
          pageCount: 1,
          model: "claude-haiku-4-5",
          scannedById: "user-7",
        });
        expect(data.invoiceDate).toEqual(new Date("2026-08-01"));
        expect(data.subtotal.toString()).toBe("100.01");
        expect(data.tax.toString()).toBe("8.25");
        expect(data.total.toString()).toBe("108.26");
        expect(typeof data.scanDurationMs).toBe("number");
        // The full result, matched lines included — nothing the model produced is dropped.
        expect(data.extractedPayload.items).toHaveLength(2);
        expect(result.scanId).toBe("scan-1");
      });

      it("stores the pages as received and records the first key", async () => {
        respondWith(fullInvoice);

        await service.scanInvoice([jpegPage, { buffer: Buffer.from("p2"), mimeType: "image/png" }]);

        expect(storage.upload).toHaveBeenCalledTimes(2);
        expect(storage.upload.mock.calls[0][0]).toBe("invoice-scans/scan-1/1.jpg");
        expect(storage.upload.mock.calls[1][0]).toBe("invoice-scans/scan-1/2.png");
        expect(invoiceScan.update).toHaveBeenCalledWith({
          where: { id: "scan-1" },
          data: { fileKey: "invoice-scans/scan-1/1.jpg" },
        });
      });

      it("still returns a successful scan when storage fails — the extraction is the valuable part", async () => {
        respondWith(fullInvoice);
        storage.upload.mockRejectedValue(new Error("disk full"));

        const result = await service.scanInvoice([jpegPage]);

        expect(result.items).toHaveLength(2);
        expect(result.scanId).toBe("scan-1");
        expect(invoiceScan.update).not.toHaveBeenCalled();
      });

      it("still returns a successful scan when the row cannot be written", async () => {
        respondWith(fullInvoice);
        invoiceScan.create.mockRejectedValue(new Error("db down"));

        const result = await service.scanInvoice([jpegPage]);

        expect(result.items).toHaveLength(2);
        expect(result.scanId).toBeNull();
      });

      it("returns the stored payload for bytes already scanned, without calling the model", async () => {
        invoiceScan.findFirst.mockResolvedValue({
          id: "scan-earlier",
          createdAt: new Date("2026-08-01T10:00:00Z"),
          status: "POSTED",
          vendorBillId: "vb-3",
          supplierInvoiceNumber: "INV08841",
          total: 108.26,
          extractedPayload: { supplier: "Acme Foods", items: [{ extractedName: "Widget" }] },
          vendorBill: { billNumber: "BILL-2026-0003" },
        });

        const result = await service.scanInvoice([jpegPage]);

        expect(mockAnthropicCreate).not.toHaveBeenCalled();
        expect(invoiceScan.create).not.toHaveBeenCalled();
        expect(result.supplier).toBe("Acme Foods");
        expect(result.items).toHaveLength(1);
        expect(result.scanId).toBe("scan-earlier");
        expect(result.priorScan).toEqual({
          scanId: "scan-earlier",
          scannedAt: new Date("2026-08-01T10:00:00Z"),
          status: "POSTED",
          vendorBillId: "vb-3",
          billNumber: "BILL-2026-0003",
          supplierInvoiceNumber: "INV08841",
          total: 108.26,
        });
      });

      it("re-matches a cache hit — a just-taught alias applies on a rescan of the same file", async () => {
        // The stored payload's line was unmatched at scan time (no alias existed yet).
        invoiceScan.findFirst.mockResolvedValue({
          id: "scan-earlier",
          createdAt: new Date("2026-08-01T10:00:00Z"),
          status: "SCANNED",
          vendorBillId: null,
          supplierInvoiceNumber: null,
          total: 5,
          extractedPayload: {
            supplier: "Acme Foods",
            items: [
              {
                extractedName: "Widget",
                qty: 1,
                unitCost: 5,
                matchedProductId: null,
                matchedProductName: null,
                confidence: "none",
              },
            ],
          },
          vendorBill: null,
        });
        // The operator has since taught an alias — the rescan must pick it up.
        prisma.supplier.findMany.mockResolvedValue([{ id: "sup-1", name: "Acme Foods" }]);
        prisma.productAlias.findMany.mockResolvedValue([
          {
            rawText: "WIDGET",
            supplierId: "sup-1",
            productId: "prod-taught",
            expenseCategoryId: null,
          },
        ]);
        prisma.product.findMany.mockResolvedValue([
          {
            id: "prod-taught",
            name: "Taught Widget",
            sku: null,
            barcode: null,
            parentProductId: null,
            parent: null,
          },
        ]);

        const result = await service.scanInvoice([jpegPage]);

        expect(mockAnthropicCreate).not.toHaveBeenCalled();
        // The stored extractedPayload must never be rewritten by a rescan.
        expect(invoiceScan.create).not.toHaveBeenCalled();
        expect(invoiceScan.update).not.toHaveBeenCalled();
        expect(result.items[0]).toMatchObject({
          matchedProductId: "prod-taught",
          matchedProductName: "Taught Widget",
          confidence: "high",
          matchSource: "alias",
        });
        expect(result.supplierId).toBe("sup-1");
      });

      it("looks the file up by hash, skipping scans the operator discarded", async () => {
        respondWith(fullInvoice);

        await service.scanInvoice([jpegPage]);

        const where = invoiceScan.findFirst.mock.calls[0][0].where;
        expect(where.fileHash).toMatch(/^[0-9a-f]{64}$/);
        expect(where.status).toEqual({ not: "DISCARDED" });
      });

      it("re-scans rather than failing when the prior-scan lookup errors", async () => {
        respondWith(fullInvoice);
        invoiceScan.findFirst.mockRejectedValue(new Error("db down"));

        const result = await service.scanInvoice([jpegPage]);

        expect(mockAnthropicCreate).toHaveBeenCalled();
        expect(result.items).toHaveLength(2);
      });
    });
  });

  describe("recordPayment", () => {
    it("rejects a payment that exceeds the remaining balance", async () => {
      prisma.vendorBill.findUnique.mockResolvedValue(
        bill({ totalOwed: 100, payments: [{ amount: 40 }] }),
      );

      await expect(service.recordPayment("bill-1", { amount: 61, method: "CASH" })).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.billPayment.create).not.toHaveBeenCalled();
    });

    it("records a payment within the remaining balance and rounds the running total", async () => {
      prisma.vendorBill.findUnique.mockResolvedValue(
        bill({ totalOwed: 100, payments: [{ amount: 40 }] }),
      );
      prisma.billPayment.create.mockResolvedValue({});
      prisma.vendorBill.update.mockResolvedValue({});

      await service.recordPayment("bill-1", { amount: 60, method: "CASH" });

      const data = prisma.vendorBill.update.mock.calls[0][0].data;
      expect(data.totalPaid).toBe(100);
      expect(data.status).toBe("PAID");
    });
  });
});
