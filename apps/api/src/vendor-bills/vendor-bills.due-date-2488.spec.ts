/**
 * #2488 — a vendor bill's dueDate is stored as the UTC-midnight stamp of the LITERAL day the client
 * named (the #2197/#2256 rule, `calendarFieldStamp`), never `new Date(raw)`, whose offset moves the
 * day; a value naming no real day is a 400 before anything is read or written. Both write paths:
 * create() and update(). Bootstrap copied from vendor-bills.po-link.spec.ts.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { VendorBillsService } from "./vendor-bills.service";
import { PrismaService } from "../prisma/prisma.service";
import { PlatformConfigService } from "../platform-admin/platform-config.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { DuplicateMatchService } from "../import/duplicate-match.service";
import { StorageService } from "../storage/storage.service";
import { InventoryService } from "../inventory/inventory.service";
import { ProductAliasService } from "../import/product-alias.service";
import { createMockPrisma } from "../testing/prisma-mock";

jest.mock("@anthropic-ai/sdk", () => ({
  __esModule: true,
  default: jest.fn(() => ({ messages: { create: jest.fn() } })),
}));
jest.mock("sharp", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    rotate: jest.fn().mockReturnThis(),
    jpeg: jest.fn().mockReturnThis(),
    toBuffer: jest.fn(),
  })),
}));

describe("VendorBillsService — #2488 dueDate is the literal calendar day", () => {
  let service: VendorBillsService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VendorBillsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: PlatformConfigService,
          useValue: {
            resolveAnthropicKey: jest.fn().mockResolvedValue(null),
            recordAiUsage: jest.fn(),
          },
        },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        {
          provide: DuplicateMatchService,
          useValue: {
            normalizeNumber: (raw: string) => (raw ?? "").toUpperCase().replace(/\s+/g, ""),
            findVendorBillDuplicate: jest.fn().mockResolvedValue(null),
            findScanDuplicate: jest.fn().mockResolvedValue(null),
          },
        },
        { provide: StorageService, useValue: { upload: jest.fn(), presignedUrl: jest.fn() } },
        {
          provide: InventoryService,
          useValue: {
            recomputeProductInTx: jest.fn(),
            lockProducts: jest.fn(),
            fireStockAlerts: jest.fn(),
            createDraftPurchaseOrderInTx: jest.fn(),
          },
        },
        {
          provide: ProductAliasService,
          useValue: { resolveMany: jest.fn(), learn: jest.fn(), unlearn: jest.fn() },
        },
      ],
    }).compile();
    service = module.get(VendorBillsService);
    prisma.vendorBill.create.mockResolvedValue({ id: "bill-new" });
  });

  const day25 = new Date("2026-09-25T00:00:00.000Z");
  // 23:30 at -05:00 is 04:30Z on the 26th; 20:00 at -04:00 is exactly 00:00Z on the 26th.
  const OFFSET = "2026-09-25T23:30:00-05:00";
  const UTC_MIDNIGHT = "2026-09-25T20:00:00-04:00";
  const base = { requireSupplier: false, totalOwed: 10, items: [] };

  describe("create()", () => {
    it.each([
      ["an offset different from UTC", OFFSET],
      ["an instant at exactly UTC midnight of the next day", UTC_MIDNIGHT],
      ["a bare calendar date", "2026-09-25"],
    ])("stores the literal day: %s", async (_label, dueDate) => {
      await service.create({ ...base, dueDate });
      expect(prisma.vendorBill.create.mock.calls[0][0].data.dueDate).toEqual(day25);
    });

    it("no dueDate stays null", async () => {
      await service.create({ ...base });
      expect(prisma.vendorBill.create.mock.calls[0][0].data.dueDate).toBeNull();
    });

    it.each(["2026-02-31", "2026-13-01", "not-a-date"])(
      "a dueDate of %s is a 400 before anything is written",
      async (dueDate) => {
        await expect(service.create({ ...base, dueDate })).rejects.toThrow(
          "dueDate must be a calendar date (YYYY-MM-DD)",
        );
        expect(prisma.vendorBill.create).not.toHaveBeenCalled();
      },
    );
  });

  describe("update()", () => {
    const draft = {
      id: "bill-1",
      billNumber: "BILL-2026-0042",
      supplierId: null,
      status: "DRAFT",
      purchaseOrderId: null,
      totalOwed: 10,
      totalPaid: 0,
      taxAmount: null,
      dueDate: new Date("2026-09-01T00:00:00.000Z"),
    };
    beforeEach(() => {
      prisma.vendorBill.findUnique.mockResolvedValue(draft);
      prisma.vendorBill.update.mockResolvedValue({ ...draft });
    });

    it.each([OFFSET, UTC_MIDNIGHT])("stores the literal day for %s", async (dueDate) => {
      await service.update("bill-1", { dueDate });
      expect(prisma.vendorBill.update.mock.calls[0][0].data.dueDate).toEqual(day25);
    });

    it("an empty dueDate still clears it, and an absent one leaves it alone", async () => {
      await service.update("bill-1", { dueDate: "" });
      expect(prisma.vendorBill.update.mock.calls[0][0].data.dueDate).toBeNull();
      prisma.vendorBill.update.mockClear();
      await service.update("bill-1", { notes: "x" });
      expect(prisma.vendorBill.update.mock.calls[0][0].data).not.toHaveProperty("dueDate");
    });

    it("a dueDate that names no real day is a 400 before the bill is even read", async () => {
      await expect(service.update("bill-1", { dueDate: "2026-02-31" })).rejects.toThrow(
        "dueDate must be a calendar date (YYYY-MM-DD)",
      );
      expect(prisma.vendorBill.findUnique).not.toHaveBeenCalled();
      expect(prisma.vendorBill.update).not.toHaveBeenCalled();
    });
  });
});
