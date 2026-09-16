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
 * B451 Phase A — Strix coverage gap 4 (business-logic financial-total
 * manipulation) on POST /vendor-bills. VendorBillItemDto (dto/create-vendor-
 * bill.dto.ts) declares `qty`/`unitCost`/`unitPrice`/`lineTotal` as bare
 * `@IsOptional() @IsNumber()` — no `@Min(0)` — unlike every sibling line-item
 * DTO in the codebase (CreateInvoiceItemDto.qty/unitPrice, OrderItemDto.qty/
 * unitPrice all carry `@Min`). vendor-bills.service.ts:195-197 then computes
 * `totalOwed = Σ (qty || 1) * (unitCost ?? unitPrice ?? 0)` with no floor
 * check anywhere before persisting.
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

  it("CONFIRMED: a negative unitCost line persists a negative totalOwed", async () => {
    prisma.vendorBill.create.mockImplementation((args: any) =>
      Promise.resolve({ id: "vb-1", supplierId: null, ...args.data }),
    );

    await service.create({
      requireSupplier: false,
      items: [{ description: "Refund abuse line", qty: 1, unitCost: -500 }],
    });

    const createCall = prisma.vendorBill.create.mock.calls[0][0];
    expect(createCall.data.totalOwed).toBe(-500);
  });

  it("CONFIRMED: a negative qty on an otherwise-legitimate unitCost also drives totalOwed negative", async () => {
    prisma.vendorBill.create.mockImplementation((args: any) =>
      Promise.resolve({ id: "vb-1", supplierId: null, ...args.data }),
    );

    await service.create({
      requireSupplier: false,
      items: [{ description: "Negative qty line", qty: -10, unitCost: 50 }],
    });

    const createCall = prisma.vendorBill.create.mock.calls[0][0];
    expect(createCall.data.totalOwed).toBe(-500);
  });
});
