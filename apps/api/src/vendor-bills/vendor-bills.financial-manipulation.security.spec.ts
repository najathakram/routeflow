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
 * — no bound at all — so vendor-bills.service.ts's `totalOwed = Σ (qty || 1)
 * * (unitCost ?? unitPrice ?? 0)` had no floor check before persisting.
 *
 * Phase B FIX v1: `@Min(0)` on all four VendorBillItemDto fields.
 *
 * Opus review of #791: `@Min(0)` on unitCost/unitPrice/lineTotal broke real
 * mobile scan-to-bill traffic — a scanned discount or deposit-return line is
 * a LEGITIMATE negative cost, not an attack (see
 * apps/mobile/lib/vendor-bill-scan.ts buildBillDtoFromScan). Fix v2: `qty`
 * keeps `@Min(0)` (every real caller sends non-negative qty); unitCost/
 * unitPrice/lineTotal are unbounded again at the DTO layer. The actual
 * guard — `assertMoneyInvariantsOrThrow` on the computed `totalOwed` — stays,
 * and now does the real work: it catches a bill that NETS negative
 * regardless of which line carried the negative amount, while a bill with
 * one negative (discount/deposit) line that still nets positive is
 * accepted.
 */
describe("VendorBillsService.create — negative-line/net-negative handling (B451 gap 4)", () => {
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

  it("REJECTED: a single negative-unitCost line with nothing to offset it nets negative — 400 MONEY_INVARIANT", async () => {
    prisma.vendorBill.create.mockImplementation((args: any) =>
      Promise.resolve({ id: "vb-1", supplierId: null, ...args.data }),
    );

    await expect(
      service.create({
        requireSupplier: false,
        items: [{ description: "Refund abuse line", qty: 1, unitCost: -500 }],
      }),
    ).rejects.toMatchObject({ status: 400, response: { code: "MONEY_INVARIANT" } });

    expect(prisma.vendorBill.create).not.toHaveBeenCalled();
  });

  it("ACCEPTED: a negative-unitCost discount line alongside a positive line, netting positive, is NOT rejected (Opus review of #791 — real scan traffic)", async () => {
    prisma.vendorBill.create.mockImplementation((args: any) =>
      Promise.resolve({ id: "vb-1", supplierId: null, ...args.data }),
    );

    const bill = await service.create({
      requireSupplier: false,
      items: [
        { description: "Flour 25lb", qty: 1, unitCost: 1000 },
        { description: "Loyalty discount", qty: 1, unitCost: -500 },
      ],
    });

    expect(bill).toBeDefined();
    const createCall = prisma.vendorBill.create.mock.calls[0][0];
    expect(createCall.data.totalOwed).toBe(500);
  });

  it("REJECTED: lines net negative overall even though no single line is individually implausible — 400 MONEY_INVARIANT", async () => {
    prisma.vendorBill.create.mockImplementation((args: any) =>
      Promise.resolve({ id: "vb-1", supplierId: null, ...args.data }),
    );

    await expect(
      service.create({
        requireSupplier: false,
        items: [
          { description: "Small item", qty: 1, unitCost: 10 },
          { description: "Oversized discount", qty: 1, unitCost: -500 },
        ],
      }),
    ).rejects.toMatchObject({ status: 400, response: { code: "MONEY_INVARIANT" } });

    expect(prisma.vendorBill.create).not.toHaveBeenCalled();
  });
});
