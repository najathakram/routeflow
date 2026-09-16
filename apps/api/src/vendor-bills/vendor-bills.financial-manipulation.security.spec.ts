import { Test, TestingModule } from "@nestjs/testing";
import { VendorBillsService } from "./vendor-bills.service";
import { PrismaService } from "../prisma/prisma.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { PlatformConfigService } from "../platform-admin/platform-config.service";
import { DuplicateMatchService } from "../import/duplicate-match.service";
import { ProductAliasService } from "../import/product-alias.service";
import { StorageService } from "../storage/storage.service";
import { InventoryService } from "../inventory/inventory.service";
import { createMockPrisma } from "../testing/prisma-mock";

const dupMatch = {
  normalizeNumber: (raw: string) => (raw ?? "").toUpperCase().replace(/\s+/g, ""),
  findVendorBillDuplicate: jest.fn().mockResolvedValue(null),
  findScanDuplicate: jest.fn().mockResolvedValue(null),
};

/**
 * B451 — Strix coverage gap 4 (business-logic financial-total manipulation)
 * on POST /vendor-bills. Phase A CONFIRMED this: VendorBillItemDto declared
 * `qty`/`unitCost`/`unitPrice`/`lineTotal` as bare `@IsOptional() @IsNumber()`
 * — no `@Min(0)` — unlike every sibling line-item DTO in the codebase
 * (CreateInvoiceItemDto.qty/unitPrice, OrderItemDto.qty/unitPrice all carry
 * `@Min`). vendor-bills.service.ts's `totalOwed = Σ (qty || 1) *
 * (unitCost ?? unitPrice ?? 0)` had no floor check anywhere before
 * persisting.
 *
 * Phase B FIX: `@Min(0)` added to all four VendorBillItemDto fields (closes
 * the HTTP path for both create and update, which share this DTO), plus
 * `assertMoneyInvariantsOrThrow` in the service as defense-in-depth for the
 * documented internal caller that bypasses the DTO. This spec now pins the
 * FIXED behavior.
 */
describe("VendorBillsService.create — unbounded line qty/unitCost (B451 gap 4)", () => {
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
        { provide: DuplicateMatchService, useValue: dupMatch },
        { provide: StorageService, useValue: { upload: jest.fn(), presignedUrl: jest.fn() } },
        {
          provide: InventoryService,
          useValue: { recomputeProductInTx: jest.fn(), fireStockAlerts: jest.fn() },
        },
        ProductAliasService,
      ],
    }).compile();
    service = module.get<VendorBillsService>(VendorBillsService);
  });

  it("FIXED: a negative unitCost line is now rejected, no bill persisted", async () => {
    prisma.vendorBill.create.mockImplementation((args: any) =>
      Promise.resolve({ id: "vb-1", supplierId: null, ...args.data }),
    );

    // The HTTP path also now 400s at the DTO layer (VendorBillItemDto.unitCost
    // carries @Min(0)) — this proves the service-level defense-in-depth guard
    // independently, for the documented internal caller that bypasses the DTO.
    await expect(
      service.create({
        requireSupplier: false,
        items: [{ description: "Refund abuse line", qty: 1, unitCost: -500 }],
      }),
    ).rejects.toMatchObject({ status: 400, response: { code: "MONEY_INVARIANT" } });

    expect(prisma.vendorBill.create).not.toHaveBeenCalled();
  });

  it("FIXED: a negative qty on an otherwise-legitimate unitCost is also now rejected", async () => {
    prisma.vendorBill.create.mockImplementation((args: any) =>
      Promise.resolve({ id: "vb-1", supplierId: null, ...args.data }),
    );

    await expect(
      service.create({
        requireSupplier: false,
        items: [{ description: "Negative qty line", qty: -10, unitCost: 50 }],
      }),
    ).rejects.toMatchObject({ status: 400, response: { code: "MONEY_INVARIANT" } });

    expect(prisma.vendorBill.create).not.toHaveBeenCalled();
  });
});
