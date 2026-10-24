import * as fs from "fs";
import * as path from "path";
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
const inventory = {
  recomputeProductInTx: jest.fn(),
  lockProducts: jest.fn(),
  fireStockAlerts: jest.fn(),
};

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

describe("supplier payment: coded, structured refusals (B987-E1 b)", () => {
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

  const refusal = async (p: Promise<unknown>) => {
    const err: any = await p.catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getStatus()).toBe(400);
    return err.getResponse() as Record<string, unknown>;
  };

  describe("recordPayment (one bill)", () => {
    it("NOT_POSITIVE, FULLY_PAID (billId is the documented request echo) and OVER_BALANCE keep their sentences and carry fields", async () => {
      expect(await refusal(service.recordPayment("bill-1", { amount: 0, method: "CASH" }))).toEqual(
        {
          code: "SUPPLIER_PAYMENT_NOT_POSITIVE",
          message: "Payment amount must be greater than zero.",
        },
      );
      prisma.vendorBill.findUnique.mockResolvedValue(
        vendorBill({ totalOwed: D(100), payments: [{ amount: D(100) }] }),
      );
      expect(await refusal(service.recordPayment("bill-1", { amount: 5, method: "CASH" }))).toEqual(
        {
          code: "SUPPLIER_PAYMENT_FULLY_PAID",
          message: "Bill already fully paid",
          billId: "bill-1",
        },
      );
      prisma.vendorBill.findUnique.mockResolvedValue(
        vendorBill({ totalOwed: D(100), payments: [{ amount: D(80) }] }),
      );
      expect(
        await refusal(service.recordPayment("bill-1", { amount: 30, method: "CASH" })),
      ).toEqual({
        code: "SUPPLIER_PAYMENT_OVER_BALANCE",
        message: "Payment amount exceeds the remaining balance of 20.00.",
        remaining: 20,
      });
    });

    it("an unknown or other tenant's bill id is the UNCODED 404", async () => {
      prisma.vendorBill.findUnique.mockResolvedValue(null);
      const err: any = await service
        .recordPayment("bill-x", { amount: 5, method: "CASH" })
        .catch((e) => e);
      expect(err).toBeInstanceOf(NotFoundException);
      expect(err.getResponse()).not.toHaveProperty("code");
    });
  });

  describe("recordSupplierPayment (group)", () => {
    it("ALLOCATIONS_EXCEED_PAYMENT: allocatedTotal is the pre-transaction requestedTotal, totalAmount the UNROUNDED request value (half-cent pin)", async () => {
      const body = await refusal(
        service.recordSupplierPayment(
          paymentDto({
            totalAmount: 100.004,
            allocations: [
              { vendorBillId: "bill-1", amount: 60.0025 },
              { vendorBillId: "bill-2", amount: 40.0025 },
            ],
          }),
        ),
      );
      expect(body).toEqual({
        code: "SUPPLIER_ALLOCATIONS_EXCEED_PAYMENT",
        message: "Allocations total 100.01 exceed the payment amount of 100.00.",
        allocatedTotal: 100.01, // roundMoney of the requested sum, exactly the number the message prints
        totalAmount: 100.004, // NOT rounded: 100.00 would hide that the request was half a cent over
      });
      expect(prisma.vendorBill.findUnique).not.toHaveBeenCalled();
    });

    it("ALLOCATION_WRONG_SUPPLIER / BILL_VOID / OVER_BALANCE name the bill from the loaded row and carry the amounts", async () => {
      prisma.vendorBill.findUnique.mockResolvedValue(
        vendorBill({ id: "bill-9", supplierId: "sup-OTHER" }),
      );
      expect(
        await refusal(
          service.recordSupplierPayment(
            paymentDto({ allocations: [{ vendorBillId: "bill-9", amount: 100 }] }),
          ),
        ),
      ).toEqual({
        code: "SUPPLIER_ALLOCATION_WRONG_SUPPLIER",
        message: "Bill BILL-2026-0001 does not belong to the selected supplier.",
        billId: "bill-9",
        billNumber: "BILL-2026-0001",
      });
      prisma.vendorBill.findUnique.mockResolvedValue(vendorBill({ status: "VOID" }));
      expect(await refusal(service.recordSupplierPayment(paymentDto()))).toEqual({
        code: "SUPPLIER_ALLOCATION_BILL_VOID",
        message: "Bill BILL-2026-0001 is void and cannot be paid.",
        billId: "bill-1",
        billNumber: "BILL-2026-0001",
      });
      prisma.vendorBill.findUnique.mockResolvedValue(
        vendorBill({ totalOwed: D(100), payments: [{ amount: D(80) }] }),
      );
      expect(
        await refusal(
          service.recordSupplierPayment(
            paymentDto({ totalAmount: 30, allocations: [{ vendorBillId: "bill-1", amount: 30 }] }),
          ),
        ),
      ).toEqual({
        code: "SUPPLIER_ALLOCATION_OVER_BALANCE",
        message:
          "Allocation of 30.00 to bill BILL-2026-0001 exceeds its remaining balance of 20.00.",
        billId: "bill-1",
        billNumber: "BILL-2026-0001",
        amount: 30,
        remaining: 20,
      });
    });

    it("another tenant's bill id in an allocation is the UNCODED 404, never a coded 400 with its fields", async () => {
      prisma.vendorBill.findUnique.mockResolvedValue(null);
      const err: any = await service.recordSupplierPayment(paymentDto()).catch((e) => e);
      expect(err).toBeInstanceOf(NotFoundException);
      const body = err.getResponse() as Record<string, unknown>;
      expect(body).not.toHaveProperty("code");
      expect(body).not.toHaveProperty("billNumber");
    });
  });

  it("source pin: the request-echo billId on FULLY_PAID is commented as such", () => {
    const src = fs.readFileSync(path.join(__dirname, "vendor-bills.service.ts"), "utf8");
    expect(src).toMatch(
      /REQUEST ECHO[\s\S]{0,300}SUPPLIER_PAYMENT_FULLY_PAID|SUPPLIER_PAYMENT_FULLY_PAID[\s\S]{0,300}REQUEST ECHO/,
    );
  });
});
