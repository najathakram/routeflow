import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { PlatformConfigService } from "../platform-admin/platform-config.service";
import { Prisma, PaymentMethod } from "@prisma/client";
import { VendorBillsService } from "./vendor-bills.service";
import { PrismaService } from "../prisma/prisma.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { DuplicateMatchService } from "../import/duplicate-match.service";
import { ProductAliasService } from "../import/product-alias.service";
import { StorageService } from "../storage/storage.service";
import { InventoryService } from "../inventory/inventory.service";
import { createMockPrisma } from "../testing/prisma-mock";
import type { RecordSupplierPaymentDto } from "./dto/supplier-payment.dto";

const D = (n: number | string) => new Prisma.Decimal(n);

/**
 * createMockPrisma() predates SupplierCredit (added by WP1's migration #2
 * schema change) — graft a model proxy onto both the tenant-scoped surface
 * and the tenantTransaction surface, the same pattern
 * vendor-bills.service.spec.ts already uses for InvoiceScan.
 */
function graftSupplierCredit(prisma: ReturnType<typeof createMockPrisma>) {
  const model = {
    findMany: jest.fn().mockResolvedValue([]),
    findUnique: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue({}),
    update: jest.fn().mockResolvedValue({}),
  };
  (prisma as any).supplierCredit = model;
  (prisma.forTenant() as any).supplierCredit = model;
  return model;
}

const dupMatch = {
  normalizeNumber: (raw: string) => (raw ?? "").toUpperCase().replace(/\s+/g, ""),
  findVendorBillDuplicate: jest.fn(),
  findScanDuplicate: jest.fn().mockResolvedValue(null),
};
const storage = { upload: jest.fn(), presignedUrl: jest.fn() };
const inventory = { recomputeProductInTx: jest.fn(), fireStockAlerts: jest.fn() };

/** A vendor bill as `recordSupplierPayment`/`create` would load it. */
const vendorBill = (overrides: Record<string, unknown> = {}) => ({
  id: "bill-1",
  billNumber: "BILL-2026-0001",
  supplierId: "sup-1",
  status: "RECEIVED",
  totalOwed: D(100),
  totalPaid: D(0),
  payments: [] as { amount: Prisma.Decimal }[],
  ...overrides,
});

const paymentDto = (overrides: Partial<RecordSupplierPaymentDto> = {}): RecordSupplierPaymentDto =>
  ({
    supplierId: "sup-1",
    totalAmount: 100,
    method: PaymentMethod.CASH,
    allocations: [{ vendorBillId: "bill-1", amount: 100 }],
    ...overrides,
  }) as RecordSupplierPaymentDto;

describe("VendorBillsService — supplier payment allocation (WP2)", () => {
  let service: VendorBillsService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    graftSupplierCredit(prisma);
    // recordSupplierPayment resolves the supplier through the tenant client
    // before it writes anything — see the "unknown supplier" case below.
    prisma.supplier.findUnique.mockResolvedValue({ id: "sup-1", name: "Acme Wholesale" } as any);
    dupMatch.findVendorBillDuplicate.mockReset().mockResolvedValue(null);
    dupMatch.findScanDuplicate.mockReset().mockResolvedValue(null);

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
        { provide: StorageService, useValue: storage },
        { provide: InventoryService, useValue: inventory },
        ProductAliasService,
      ],
    }).compile();

    service = module.get<VendorBillsService>(VendorBillsService);
  });

  describe("recordSupplierPayment", () => {
    it("creates one BillPayment per allocated bill sharing one paymentGroupId, and recomputes each bill's status", async () => {
      const bills: Record<string, ReturnType<typeof vendorBill>> = {
        "bill-1": vendorBill({ id: "bill-1", totalOwed: D(100) }),
        "bill-2": vendorBill({ id: "bill-2", totalOwed: D(50) }),
        "bill-3": vendorBill({ id: "bill-3", totalOwed: D(200) }),
      };
      prisma.vendorBill.findUnique
        .mockResolvedValueOnce(bills["bill-1"])
        .mockResolvedValueOnce(bills["bill-2"])
        .mockResolvedValueOnce(bills["bill-3"]);
      prisma.vendorBill.update
        .mockResolvedValueOnce({ id: "bill-1", status: "PAID", totalPaid: D(100) })
        .mockResolvedValueOnce({ id: "bill-2", status: "PAID", totalPaid: D(50) })
        .mockResolvedValueOnce({ id: "bill-3", status: "PAID", totalPaid: D(200) });

      const result = await service.recordSupplierPayment(
        paymentDto({
          totalAmount: 350,
          allocations: [
            { vendorBillId: "bill-1", amount: 100 },
            { vendorBillId: "bill-2", amount: 50 },
            { vendorBillId: "bill-3", amount: 200 },
          ],
        }),
      );

      expect(prisma.billPayment.create).toHaveBeenCalledTimes(3);
      const groupIds = prisma.billPayment.create.mock.calls.map(
        (c: any) => c[0].data.paymentGroupId,
      );
      expect(groupIds.every((g: string) => !!g)).toBe(true);
      expect(new Set(groupIds).size).toBe(1);
      expect(result.paymentGroupId).toBe(groupIds[0]);

      expect(result.bills).toEqual([
        { id: "bill-1", status: "PAID", totalPaid: 100 },
        { id: "bill-2", status: "PAID", totalPaid: 50 },
        { id: "bill-3", status: "PAID", totalPaid: 200 },
      ]);
      expect(result.excess).toBe(0);
      expect(prisma.supplierCredit.create).not.toHaveBeenCalled();
    });

    it("throws 400 when an allocation targets a bill belonging to a different supplier, and writes nothing", async () => {
      prisma.vendorBill.findUnique.mockResolvedValue(
        vendorBill({ id: "bill-9", supplierId: "sup-OTHER", totalOwed: D(100) }),
      );

      await expect(
        service.recordSupplierPayment(
          paymentDto({ allocations: [{ vendorBillId: "bill-9", amount: 100 }] }),
        ),
      ).rejects.toThrow(BadRequestException);

      expect(prisma.billPayment.create).not.toHaveBeenCalled();
      expect(prisma.vendorBill.update).not.toHaveBeenCalled();
      expect(prisma.supplierCredit.create).not.toHaveBeenCalled();
    });

    it("throws 400 when an allocation targets a VOID bill, and writes nothing", async () => {
      // A voided bill keeps its totalOwed and gets no offsetting payment rows,
      // so the remaining-balance arithmetic still says $100 is payable — and
      // the status recompute would overwrite VOID with PAID, resurrecting a
      // cancelled bill (whose stock was already reversed) into AP.
      prisma.vendorBill.findUnique.mockResolvedValue(
        vendorBill({ status: "VOID", totalOwed: D(100), payments: [] }),
      );

      await expect(service.recordSupplierPayment(paymentDto())).rejects.toThrow(
        BadRequestException,
      );

      expect(prisma.billPayment.create).not.toHaveBeenCalled();
      expect(prisma.vendorBill.update).not.toHaveBeenCalled();
      expect(prisma.supplierCredit.create).not.toHaveBeenCalled();
    });

    it("throws 404 for a supplier outside the caller's tenant, before any money is written", async () => {
      // The tenant-scoped lookup returns null both for a deleted id and for
      // another tenant's supplier; without this guard an empty allocation list
      // would mint a SupplierCredit nobody can see or spend.
      prisma.supplier.findUnique.mockResolvedValue(null as any);

      await expect(
        service.recordSupplierPayment(paymentDto({ totalAmount: 500, allocations: [] })),
      ).rejects.toThrow(NotFoundException);

      expect(prisma.supplierCredit.create).not.toHaveBeenCalled();
      expect(prisma.billPayment.create).not.toHaveBeenCalled();
    });

    it("throws 400 when an allocation exceeds the bill's remaining balance", async () => {
      // $100 owed, $80 already paid via the ledger -> only $20 left to allocate.
      prisma.vendorBill.findUnique.mockResolvedValue(
        vendorBill({ totalOwed: D(100), payments: [{ amount: D(80) }] }),
      );

      await expect(
        service.recordSupplierPayment(
          paymentDto({
            totalAmount: 30,
            allocations: [{ vendorBillId: "bill-1", amount: 30 }],
          }),
        ),
      ).rejects.toThrow(BadRequestException);

      expect(prisma.billPayment.create).not.toHaveBeenCalled();
    });

    it("throws 400 when allocations sum past totalAmount, before touching any bill", async () => {
      await expect(
        service.recordSupplierPayment(
          paymentDto({
            totalAmount: 100,
            allocations: [
              { vendorBillId: "bill-1", amount: 60 },
              { vendorBillId: "bill-2", amount: 60 },
            ],
          }),
        ),
      ).rejects.toThrow(BadRequestException);

      expect(prisma.vendorBill.findUnique).not.toHaveBeenCalled();
      expect(prisma.billPayment.create).not.toHaveBeenCalled();
    });

    it("creates a SupplierCredit with amount === balance === excess on overpayment, and rejects nothing", async () => {
      prisma.vendorBill.findUnique.mockResolvedValue(vendorBill({ totalOwed: D(100) }));
      prisma.vendorBill.update.mockResolvedValueOnce({
        id: "bill-1",
        status: "PAID",
        totalPaid: D(100),
      });

      const result = await service.recordSupplierPayment(
        paymentDto({
          totalAmount: 150,
          allocations: [{ vendorBillId: "bill-1", amount: 100 }],
        }),
      );

      expect(result.excess).toBe(50);
      expect(prisma.supplierCredit.create).toHaveBeenCalledTimes(1);
      const creditData = (prisma.supplierCredit as any).create.mock.calls[0][0].data;
      expect(creditData.amount).toBe(50);
      expect(creditData.balance).toBe(50);
      expect(creditData.supplierId).toBe("sup-1");
    });

    it("landmine 1: a short-received PARTIAL bill with no payments is fully payable for its whole totalOwed", async () => {
      // PARTIAL here means a SHORT RECEIPT, not a part payment: the ledger
      // (payments: []) is empty even though the stale totalPaid COLUMN below
      // is deliberately wrong, to pin that eligibility reads the ledger, never
      // the denormalised column and never status.
      prisma.vendorBill.findUnique.mockResolvedValue(
        vendorBill({ status: "PARTIAL", totalOwed: D(100), totalPaid: D(999), payments: [] }),
      );
      prisma.vendorBill.update.mockResolvedValueOnce({
        id: "bill-1",
        status: "PAID",
        totalPaid: D(100),
      });

      const result = await service.recordSupplierPayment(
        paymentDto({
          totalAmount: 100,
          allocations: [{ vendorBillId: "bill-1", amount: 100 }],
        }),
      );

      expect(result.bills).toEqual([{ id: "bill-1", status: "PAID", totalPaid: 100 }]);
      expect(prisma.billPayment.create).toHaveBeenCalledTimes(1);
      expect(prisma.billPayment.create.mock.calls[0][0].data.amount).toBe(100);
    });
  });

  describe("create — auto-apply supplier credit (WP2)", () => {
    it("draws available credit oldest-first, never exceeds what the bill owes, and leaves the remaining credit balance correct", async () => {
      const creditOld = { id: "credit-old-1", balance: D(30), receivedAt: new Date("2026-01-01") };
      const creditNew = { id: "credit-new-2", balance: D(50), receivedAt: new Date("2026-02-01") };
      (prisma.supplierCredit as any).findMany.mockResolvedValue([creditOld, creditNew]);
      prisma.vendorBill.create.mockResolvedValueOnce({
        id: "bill-new",
        supplierId: "sup-1",
        totalOwed: 40,
        totalPaid: D(0),
        status: "DRAFT",
      });
      prisma.vendorBill.update.mockResolvedValueOnce({
        id: "bill-new",
        status: "DRAFT",
        totalPaid: 40,
      });

      const result = await service.create({
        supplierId: "sup-1",
        totalOwed: 40,
        allowDuplicate: true,
      });

      expect((prisma.supplierCredit as any).findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { supplierId: "sup-1", balance: { gt: 0 } },
          orderBy: { receivedAt: "asc" },
        }),
      );

      // $30 from the oldest credit first, then only the remaining $10 the bill
      // still owes from the newer one — never the full $50 available.
      expect(prisma.billPayment.create).toHaveBeenCalledTimes(2);
      const draws = prisma.billPayment.create.mock.calls.map((c: any) => c[0].data.amount);
      expect(draws).toEqual([30, 10]);
      expect(prisma.billPayment.create.mock.calls[0][0].data.method).toBe(
        PaymentMethod.CREDIT_NOTE,
      );
      // The FK is what identifies a draw — the reference string is for humans.
      expect(prisma.billPayment.create.mock.calls[0][0].data.supplierCreditId).toBe("credit-old-1");
      expect(prisma.billPayment.create.mock.calls[1][0].data.supplierCreditId).toBe("credit-new-2");
      expect(prisma.billPayment.create.mock.calls[0][0].data.reference).toBe(
        "SUPPLIER_CREDIT-credit-o",
      );

      expect((prisma.supplierCredit as any).update).toHaveBeenNthCalledWith(1, {
        where: { id: "credit-old-1" },
        data: { balance: 0 },
      });
      expect((prisma.supplierCredit as any).update).toHaveBeenNthCalledWith(2, {
        where: { id: "credit-new-2" },
        data: { balance: 40 },
      });

      // Only totalPaid moves — the bill STAYS DRAFT. Flipping it to PAID here
      // would lock a never-received bill out of edit, revert, delete and the
      // needs-mapping queue, which are all scoped to DRAFT.
      expect(prisma.vendorBill.update.mock.calls[0][0].data).toEqual({ totalPaid: 40 });
      expect(result.status).toBe("DRAFT");
      expect(result.totalPaid).toBe(40);
    });

    it("leaves a bill untouched when the supplier has no available credit", async () => {
      (prisma.supplierCredit as any).findMany.mockResolvedValue([]);
      prisma.vendorBill.create.mockResolvedValueOnce({
        id: "bill-new",
        supplierId: "sup-1",
        totalOwed: 40,
        totalPaid: D(0),
        status: "DRAFT",
      });

      const result = await service.create({
        supplierId: "sup-1",
        totalOwed: 40,
        allowDuplicate: true,
      });

      expect(prisma.billPayment.create).not.toHaveBeenCalled();
      expect(prisma.vendorBill.update).not.toHaveBeenCalled();
      expect(result.status).toBe("DRAFT");
    });
  });

  describe("void / delete — handing drawn credit back (WP2)", () => {
    const drawnBill = (status: string) => ({
      id: "bill-1",
      billNumber: "BILL-2026-0001",
      supplierId: "sup-1",
      status,
      receivedDate: null,
      totalOwed: D(40),
      totalPaid: D(40),
      items: [],
    });
    const stubDraws = () => {
      prisma.billPayment.findMany.mockResolvedValue([
        { id: "pay-1", amount: D(30), supplierCreditId: "credit-old-1" },
        { id: "pay-2", amount: D(10), supplierCreditId: "credit-new-2" },
      ] as any);
      (prisma.supplierCredit as any).findUnique
        .mockResolvedValueOnce({ id: "credit-old-1", amount: D(30), balance: D(0) })
        .mockResolvedValueOnce({ id: "credit-new-2", amount: D(50), balance: D(40) });
    };

    it("restores each draw to the credit it came from when the bill is voided", async () => {
      prisma.vendorBill.findUnique.mockResolvedValue(drawnBill("DRAFT") as any);
      stubDraws();

      await service.voidBill("bill-1");

      // $30 back to the fully-drawn credit, $10 back to the partly-drawn one —
      // and never above the amount that created it ($50, not $50 + $10).
      expect((prisma.supplierCredit as any).update).toHaveBeenNthCalledWith(1, {
        where: { id: "credit-old-1" },
        data: { balance: 30 },
      });
      expect((prisma.supplierCredit as any).update).toHaveBeenNthCalledWith(2, {
        where: { id: "credit-new-2" },
        data: { balance: 50 },
      });
      // The draw rows go with the refund, so voiding then deleting the same
      // bill cannot hand the same money back twice.
      expect(prisma.billPayment.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ["pay-1", "pay-2"] } },
      });
      expect(prisma.vendorBill.update).toHaveBeenCalledWith({
        where: { id: "bill-1" },
        data: { status: "VOID", totalPaid: 0 },
      });
    });

    it("restores drawn credit when a DRAFT bill is deleted outright", async () => {
      prisma.vendorBill.findUnique.mockResolvedValue(drawnBill("DRAFT") as any);
      stubDraws();

      await service.delete("bill-1");

      expect((prisma.supplierCredit as any).update).toHaveBeenCalledTimes(2);
      expect(prisma.vendorBill.delete).toHaveBeenCalledWith({ where: { id: "bill-1" } });
    });
  });

  /**
   * Auto-applied credit leaves the bill DRAFT, so `update()` still accepts it —
   * which means an edit can move the two things the draw was sized and
   * addressed by. The draw has to be re-based on the edited bill or the money
   * is stranded (lowered total) or spent out of the wrong account (re-pointed
   * supplier).
   */
  describe("update — re-basing drawn credit on an edited DRAFT bill (WP2)", () => {
    const drawnDraft = (overrides: Record<string, unknown> = {}) => ({
      id: "bill-1",
      billNumber: "BILL-2026-0001",
      supplierId: "sup-1",
      status: "DRAFT",
      totalOwed: D(500),
      totalPaid: D(500),
      ...overrides,
    });
    const stubDraw = () => {
      prisma.billPayment.findMany.mockResolvedValue([
        { id: "pay-1", amount: D(500), supplierCreditId: "credit-1" },
      ] as any);
      (prisma.supplierCredit as any).findUnique.mockResolvedValue({
        id: "credit-1",
        amount: D(500),
        balance: D(0),
      });
    };

    it("re-draws only what the corrected total owes, handing the rest back to the credit", async () => {
      prisma.vendorBill.findUnique.mockResolvedValue(drawnDraft() as any);
      stubDraw();
      (prisma.supplierCredit as any).findMany.mockResolvedValue([
        { id: "credit-1", balance: D(500), receivedAt: new Date("2026-01-01") },
      ]);
      prisma.vendorBill.update
        .mockResolvedValueOnce({
          id: "bill-1",
          supplierId: "sup-1",
          status: "DRAFT",
          totalOwed: 50,
          totalPaid: 0,
        } as any)
        .mockResolvedValueOnce({ id: "bill-1", status: "DRAFT", totalPaid: 50 } as any);

      const result = await service.update("bill-1", {
        items: [{ description: "Corrected line", qty: 1, unitCost: 50 }],
      });

      // The whole $500 goes back first...
      expect((prisma.supplierCredit as any).update).toHaveBeenNthCalledWith(1, {
        where: { id: "credit-1" },
        data: { balance: 500 },
      });
      expect(prisma.vendorBill.update.mock.calls[0][0].data).toEqual(
        expect.objectContaining({ totalOwed: 50, totalPaid: 0 }),
      );
      // ...then only the $50 the bill now owes comes back out of it, leaving
      // $450 on account instead of stranded on a bill that doesn't owe it.
      expect(prisma.billPayment.create).toHaveBeenCalledTimes(1);
      expect(prisma.billPayment.create.mock.calls[0][0].data.amount).toBe(50);
      expect((prisma.supplierCredit as any).update).toHaveBeenNthCalledWith(2, {
        where: { id: "credit-1" },
        data: { balance: 450 },
      });
      expect(prisma.vendorBill.update.mock.calls[1][0].data).toEqual({ totalPaid: 50 });
      expect(result.totalPaid).toBe(50);
    });

    it("returns the draw to the original supplier's credit when the bill is re-pointed", async () => {
      prisma.vendorBill.findUnique.mockResolvedValue(drawnDraft() as any);
      stubDraw();
      (prisma.supplierCredit as any).findMany.mockResolvedValue([]);
      prisma.vendorBill.update.mockResolvedValueOnce({
        id: "bill-1",
        supplierId: "sup-2",
        status: "DRAFT",
        totalOwed: D(500),
        totalPaid: 0,
      } as any);

      await service.update("bill-1", { supplierId: "sup-2" });

      expect((prisma.supplierCredit as any).update).toHaveBeenCalledWith({
        where: { id: "credit-1" },
        data: { balance: 500 },
      });
      expect(prisma.vendorBill.update.mock.calls[0][0].data).toEqual(
        expect.objectContaining({ supplierId: "sup-2", totalPaid: 0 }),
      );
      // Credit is looked up for the NEW supplier — sup-1's money never funds a
      // sup-2 bill.
      expect((prisma.supplierCredit as any).findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { supplierId: "sup-2", balance: { gt: 0 } } }),
      );
      expect(prisma.billPayment.create).not.toHaveBeenCalled();
    });
  });
});
