/**
 * Security tests for the vendor-bills module.
 *
 * F10-004: recordPayment blocked overpayment but NOT a negative/zero amount, and
 * the body was `@Body() any`. A negative amount reduced totalPaid and could flip
 * the bill status, corrupting AP balances. The service now rejects amount <= 0,
 * and the controller body is a typed DTO with @IsPositive.
 *
 * F4-003: the create/update/recordPayment bodies were untyped `any`, bypassing
 * the global ValidationPipe. They now use class-validator DTOs, exercised here.
 *
 * Duplicate detection: `check-duplicate` reads other bills, so it has to sit
 * behind the same auth/role gate as the rest of the controller and stay inside
 * the tenant scope.
 */
import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { UserRole } from "@prisma/client";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { VendorBillsService } from "./vendor-bills.service";
import { VendorBillsController } from "./vendor-bills.controller";
import { PrismaService } from "../prisma/prisma.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { DuplicateMatchService } from "../import/duplicate-match.service";
import { StorageService } from "../storage/storage.service";
import { InventoryService } from "../inventory/inventory.service";
import { ProductAliasService } from "../import/product-alias.service";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import { createMockPrisma } from "../testing/prisma-mock";
import { RecordVendorBillPaymentDto } from "./dto/record-vendor-bill-payment.dto";
import { CreateVendorBillDto } from "./dto/create-vendor-bill.dto";
import { CheckVendorBillDuplicateDto } from "./dto/check-vendor-bill-duplicate.dto";

const dupMatch = {
  normalizeNumber: (raw: string) => (raw ?? "").toUpperCase().replace(/\s+/g, ""),
  findVendorBillDuplicate: jest.fn().mockResolvedValue(null),
  findScanDuplicate: jest.fn().mockResolvedValue(null),
};

const storage = { upload: jest.fn(), presignedUrl: jest.fn() };

const inventory = { recomputeProductInTx: jest.fn(), fireStockAlerts: jest.fn() };

describe("VendorBillsService — F10-004 payment amount guard", () => {
  let service: VendorBillsService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [
        VendorBillsService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        { provide: DuplicateMatchService, useValue: dupMatch },
        { provide: StorageService, useValue: storage },
        { provide: InventoryService, useValue: inventory },
        // Real ProductAliasService against the same prisma mock — these tests do
        // not exercise alias learning, they just need the dependency satisfied.
        ProductAliasService,
      ],
    }).compile();
    service = mod.get(VendorBillsService);
  });

  it("rejects a NEGATIVE payment amount without touching the ledger", async () => {
    await expect(service.recordPayment("bill-1", { amount: -50, method: "CASH" })).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.billPayment.create).not.toHaveBeenCalled();
    expect(prisma.vendorBill.update).not.toHaveBeenCalled();
  });

  it("rejects a ZERO payment amount", async () => {
    await expect(service.recordPayment("bill-1", { amount: 0, method: "CASH" })).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.billPayment.create).not.toHaveBeenCalled();
  });

  it("records a legitimate positive payment within the remaining balance", async () => {
    prisma.vendorBill.findUnique.mockResolvedValue({ id: "bill-1", totalOwed: 100, payments: [] });

    await service.recordPayment("bill-1", { amount: 50, method: "CASH" });

    expect(prisma.billPayment.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ amount: 50, method: "CASH" }) }),
    );
    expect(prisma.vendorBill.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ totalPaid: 50, status: "PARTIAL" }),
      }),
    );
  });
});

describe("VendorBills DTOs — F4-003 input validation", () => {
  it("RecordVendorBillPaymentDto rejects a non-positive amount", async () => {
    const bad = plainToInstance(RecordVendorBillPaymentDto, { amount: -1, method: "CASH" });
    const errors = await validate(bad);
    expect(errors.some((e) => e.property === "amount")).toBe(true);
  });

  it("RecordVendorBillPaymentDto rejects an invalid method", async () => {
    const bad = plainToInstance(RecordVendorBillPaymentDto, { amount: 10, method: "BITCOIN" });
    const errors = await validate(bad);
    expect(errors.some((e) => e.property === "method")).toBe(true);
  });

  it("RecordVendorBillPaymentDto accepts a valid positive payment", async () => {
    const ok = plainToInstance(RecordVendorBillPaymentDto, {
      amount: 25.5,
      method: "CHECK",
      reference: "1234",
    });
    expect(await validate(ok)).toHaveLength(0);
  });

  it("CreateVendorBillDto accepts the web create shape (supplier + items + tax)", async () => {
    const ok = plainToInstance(CreateVendorBillDto, {
      supplierId: "sup-1",
      billDate: "2026-07-16",
      dueDate: "2026-08-16",
      notes: "n",
      taxAmount: 4.2,
      items: [{ productId: "p1", description: "Widget", qty: 2, unitCost: 3 }],
    });
    expect(await validate(ok)).toHaveLength(0);
  });

  it("CreateVendorBillDto rejects a non-numeric item qty", async () => {
    const bad = plainToInstance(CreateVendorBillDto, {
      supplierId: "sup-1",
      items: [{ description: "Widget", qty: "lots", unitCost: 3 }],
    });
    const errors = await validate(bad);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("CheckVendorBillDuplicateDto rejects a non-numeric total", async () => {
    const bad = plainToInstance(CheckVendorBillDuplicateDto, { total: "lots" });
    const errors = await validate(bad);
    expect(errors.some((e) => e.property === "total")).toBe(true);
  });

  it("CheckVendorBillDuplicateDto accepts the probe shape", async () => {
    const ok = plainToInstance(CheckVendorBillDuplicateDto, {
      supplierId: "sup-1",
      supplierInvoiceNumber: "INV-1",
      total: 100,
      billDate: "2026-06-01",
    });
    expect(await validate(ok)).toHaveLength(0);
  });
});

describe("check-duplicate — access control", () => {
  it("inherits the controller's auth + OPERATOR gate", () => {
    const guards = (Reflect.getMetadata("__guards__", VendorBillsController) ?? []) as Array<{
      name: string;
    }>;
    expect(guards.map((g) => g.name)).toEqual(
      expect.arrayContaining(["JwtAuthGuard", "RolesGuard"]),
    );
    expect(Reflect.getMetadata(ROLES_KEY, VendorBillsController)).toEqual([UserRole.OPERATOR]);
  });

  it("is declared before the :id routes so it isn't swallowed as an id", () => {
    const handlers = Object.getOwnPropertyNames(VendorBillsController.prototype);
    expect(handlers.indexOf("checkDuplicate")).toBeLessThan(handlers.indexOf("findOne"));
    expect(Reflect.getMetadata("path", VendorBillsController.prototype.checkDuplicate)).toBe(
      "check-duplicate",
    );
  });

  it("resolves the matched bill's supplier through the tenant-scoped client", async () => {
    const prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [
        VendorBillsService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        { provide: DuplicateMatchService, useValue: dupMatch },
        { provide: StorageService, useValue: storage },
        { provide: InventoryService, useValue: inventory },
        // Real ProductAliasService against the same prisma mock — these tests do
        // not exercise alias learning, they just need the dependency satisfied.
        ProductAliasService,
      ],
    }).compile();
    dupMatch.findVendorBillDuplicate.mockResolvedValue({
      id: "vb-9",
      billNumber: "BILL-2026-0009",
      status: "RECEIVED",
      totalOwed: 100,
      billDate: null,
      receivedDate: null,
      supplierId: "sup-1",
      itemCount: 1,
      matchedBy: "number",
      totalMatches: true,
    });

    await mod.get(VendorBillsService).checkDuplicate({ supplierInvoiceNumber: "INV-1" });

    expect(prisma.forTenant).toHaveBeenCalled();
    expect(prisma.supplier.findUnique).toHaveBeenCalledWith({
      where: { id: "sup-1" },
      select: { name: true },
    });
  });
});
