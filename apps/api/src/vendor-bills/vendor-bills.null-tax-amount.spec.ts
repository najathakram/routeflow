/**
 * Row 591 sibling — `UpdateVendorBillDto.taxAmount` is `@IsOptional() @IsNumber() @Min(0)`, so a `null`
 * reaches `update()`. A null is "no tax sent" exactly like an absent field: the bill keeps its stored tax.
 * It was read as a typed 0, so an items edit recomputed `totalOwed` WITHOUT the bill's tax while the stored
 * `taxAmount` stayed. Bootstrap copied from vendor-bills.due-date-2488.spec.ts.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, ConflictException } from "@nestjs/common";
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

  it("a typed taxAmount replaces the stored one in the total (control)", async () => {
    await service.update("bill-1", { items, taxAmount: 1 });
    expect(totalWritten()).toBe(11);
  });

  // ── Row 594: the typed tax is SAVED ──────────────────────────────────────────────────────────
  const writes = () => prisma.vendorBill.update.mock.calls.map((c) => c[0].data);
  const taxWritten = () => writes().find((d) => "taxAmount" in d)?.taxAmount;

  it("row 594: a tax-only edit is saved, and the total moves by the change in tax (14 -> 16)", async () => {
    await service.update("bill-1", { taxAmount: 6 });
    // Master (recorded): no write carried taxAmount, so the edit vanished.
    expect(taxWritten()).toBe(6);
    expect(totalWritten()).toBe(16);
  });

  it("row 594: a typed tax is rounded before it is saved", async () => {
    await service.update("bill-1", { taxAmount: 6.126 });
    expect(taxWritten()).toBe(6.13);
  });

  it("row 594: an items edit saves the typed tax too (10 + 1 = 11)", async () => {
    await service.update("bill-1", { items, taxAmount: 1 });
    expect(taxWritten()).toBe(1);
    expect(totalWritten()).toBe(11);
  });

  it("row 594/591: an absent or null taxAmount writes no taxAmount (the stored tax stays)", async () => {
    await service.update("bill-1", { items });
    await service.update("bill-1", { items, taxAmount: null });
    expect(taxWritten()).toBeUndefined();
  });

  it("row 594: a later items edit totals with the SAVED tax, not the stale one", async () => {
    let stored: Record<string, any> = { ...draft };
    prisma.vendorBill.findUnique.mockImplementation(async () => ({ ...stored }));
    prisma.vendorBill.update.mockImplementation(async ({ data }: any) => {
      for (const k of ["taxAmount", "totalOwed"]) if (data[k] !== undefined) stored[k] = data[k];
      return { ...stored };
    });
    await service.update("bill-1", { taxAmount: 6 }); // tax-only: 4 -> 6
    expect(stored.taxAmount).toBe(6);
    await service.update("bill-1", { items }); // 10 pre-tax + the saved 6
    expect(stored.totalOwed).toBe(16);
  });

  // ── NIT: a NULL stored tax is "unknown", never "zero" ─────────────────────────────────────────
  // A legacy bill whose $8 tax is already inside totalOwed ($108) has taxAmount NULL. Adding the new
  // tax to totalOwed would give $116; the total is rebuilt from the lines instead (100 + 8 = 108).
  const legacy = {
    ...draft,
    totalOwed: 108,
    taxAmount: null,
    items: [{ id: "i1", qtyReceived: null, qty: 10, unitCost: 10 }],
  };

  it("NIT: a tax-only edit on a NULL-tax bill rebuilds the total from its lines (108, not 116)", async () => {
    prisma.vendorBill.findUnique.mockResolvedValue(legacy);
    await service.update("bill-1", { taxAmount: 8 });
    expect(totalWritten()).toBe(108);
    expect(taxWritten()).toBe(8);
  });

  it("SA: the rebuild prices a line exactly as create/update do (unitCost ?? unitPrice, qty || 1)", async () => {
    // A stored row has no unitPrice column, so this pins the shared rule with a unitPrice-only row.
    prisma.vendorBill.findUnique.mockResolvedValue({
      ...legacy,
      items: [
        { id: "i1", qtyReceived: null, qty: 2, unitCost: null, unitPrice: 20 },
        { id: "i2", qtyReceived: null, qty: null, unitCost: 10 },
      ],
    });
    await service.update("bill-1", { taxAmount: 8 });
    expect(totalWritten()).toBe(58); // 2 x 20 + 1 x 10 + the new 8, not 10 + 8
  });

  it("NIT: the rebuilt total goes through the money invariants like an items edit (negative -> 400)", async () => {
    prisma.vendorBill.findUnique.mockResolvedValue({
      ...legacy,
      items: [{ id: "i1", qtyReceived: null, qty: 1, unitCost: -50 }],
    });
    const err = await service.update("bill-1", { taxAmount: 8 }).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse().code).toBe("MONEY_INVARIANT");
    expect(prisma.vendorBill.update).not.toHaveBeenCalled();
  });

  it("NIT: with no lines to rebuild from, the tax-only edit is a coded 409 and nothing is written", async () => {
    prisma.vendorBill.findUnique.mockResolvedValue({ ...legacy, items: [] });
    const err = await service.update("bill-1", { taxAmount: 8 }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse().code).toBe("BILL_TAX_UNKNOWN");
    expect(prisma.vendorBill.update).not.toHaveBeenCalled();
  });

  // ── B292: an edit never clears every line ────────────────────────────────────────────────────
  it.each([
    ["a plain bill", {}],
    ["a PO-linked bill", { purchaseOrderId: "po-1" }],
  ])("B292: items [] on %s is a 400 BILL_NEEDS_A_LINE and nothing is written", async (_n, over) => {
    prisma.vendorBill.findUnique.mockResolvedValue({ ...draft, ...over });
    const err = await service.update("bill-1", { items: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toEqual({
      code: "BILL_NEEDS_A_LINE",
      message: "A bill needs at least one line. Void or delete it instead.",
    });
    expect(prisma.vendorBill.update).not.toHaveBeenCalled();
    expect(prisma.vendorBillItem.deleteMany).not.toHaveBeenCalled();
  });

  it("B292: items absent is still 'no change' (the lines are not touched)", async () => {
    await service.update("bill-1", { notes: "x" });
    expect(writes().some((d) => d.items !== undefined)).toBe(false);
  });
});
