/**
 * Row 591 sibling — `UpdateVendorBillDto.taxAmount` is `@IsOptional() @IsNumber() @Min(0)`, so a `null`
 * reaches `update()`. A null is "no tax sent" exactly like an absent field: the bill keeps its stored tax.
 * It was read as a typed 0, so an items edit recomputed `totalOwed` WITHOUT the bill's tax while the stored
 * `taxAmount` stayed. Bootstrap copied from vendor-bills.due-date-2488.spec.ts.
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

describe("VendorBillsService.update — a null taxAmount keeps the stored tax (row 591)", () => {
  let service: VendorBillsService;
  let prisma: ReturnType<typeof createMockPrisma>;

  const draft = {
    id: "bill-1",
    billNumber: "BILL-2026-0042",
    supplierId: null,
    status: "DRAFT",
    purchaseOrderId: null,
    totalOwed: 14,
    totalPaid: 0,
    taxAmount: 4,
  };
  const items = [{ description: "Flour", qty: 2, unitCost: 5 }]; // 10 pre-tax

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
    prisma.vendorBill.findUnique.mockResolvedValue(draft);
    prisma.vendorBill.update.mockResolvedValue({ ...draft });
  });

  const totalWritten = () =>
    prisma.vendorBill.update.mock.calls.map((c) => c[0].data).find((d) => d.totalOwed !== undefined)
      ?.totalOwed;

  it("an items edit with taxAmount null totals pre-tax lines + the STORED tax (10 + 4)", async () => {
    await service.update("bill-1", { items, taxAmount: null });
    // Master (recorded): Number(null) = 0 -> totalOwed 10, the stored $4 tax silently dropped.
    expect(totalWritten()).toBe(14);
  });

  it("taxAmount absent is unchanged: the stored tax is folded in", async () => {
    await service.update("bill-1", { items });
    expect(totalWritten()).toBe(14);
  });

  it("an explicit taxAmount 0 is still a typed tax (control)", async () => {
    await service.update("bill-1", { items, taxAmount: 0 });
    expect(totalWritten()).toBe(10);
  });

  // update() does not persist taxAmount to the column (filed as row 594, not fixed here), so this control pins
  // only the totalOwed it computes from the typed tax.
  it("a typed taxAmount replaces the stored one in the total (control)", async () => {
    await service.update("bill-1", { items, taxAmount: 1 });
    expect(totalWritten()).toBe(11);
  });
});
