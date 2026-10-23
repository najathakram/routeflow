/**
 * B288 (SA-814 R5-3) — move-to-credit on real Postgres. A $200 cash payment on a $500 RECEIVED bill
 * becomes ONE $200 SupplierCredit dated at the payment (receivedAt = paidAt), the payment row goes,
 * the bill is back to totalPaid 0 / RECEIVED, and a second move of the same payment is a 404 that
 * mints no second credit. Harness mirrors vendor-bills.supplier-credit-lock.db.spec.ts.
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`). Throwaway `qa-b288-*` tenants.
 */
import { NotFoundException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { InventoryService } from "../inventory/inventory.service";
import { VendorBillsService } from "./vendor-bills.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { StockAlertService } from "../stock-alerts/stock-alert.service";
import { PlatformConfigService } from "../platform-admin/platform-config.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { DuplicateMatchService } from "../import/duplicate-match.service";
import { StorageService } from "../storage/storage.service";
import { ProductAliasService } from "../import/product-alias.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
const freshTenantSlug = (label: string): string => {
  tenantSeq += 1;
  return assertTestTenant(`qa-b288-${RUN_SUFFIX}-${tenantSeq}-${label}`, "move-to-credit");
};

const PAID_AT = new Date("2026-08-15T00:00:00.000Z");

describeDb("Move a bill payment to supplier credit — real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let bills: VendorBillsService;
  const createdTenantIds: string[] = [];

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VendorBillsService,
        InventoryService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: StockAlertService,
          useValue: { fireForProducts: jest.fn().mockResolvedValue({ notified: 0 }) },
        },
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
          provide: ProductAliasService,
          useValue: { resolveMany: jest.fn(), learn: jest.fn(), unlearn: jest.fn() },
        },
      ],
    }).compile();
    bills = module.get(VendorBillsService);
  });

  afterAll(async () => {
    for (const tenantId of createdTenantIds) {
      // eslint-disable-next-line no-await-in-loop
      await (async () => {
        const vb = await prisma.vendorBill.findMany({ where: { tenantId }, select: { id: true } });
        const billIds = vb.map((b) => b.id);
        await prisma.billPayment.deleteMany({ where: { vendorBillId: { in: billIds } } });
        await prisma.vendorBillItem.deleteMany({ where: { vendorBillId: { in: billIds } } });
        await prisma.vendorBill.deleteMany({ where: { tenantId } });
        await prisma.supplierCredit.deleteMany({ where: { tenantId } });
        await prisma.auditLog.deleteMany({ where: { tenantId } });
        await prisma.supplier.deleteMany({ where: { tenantId } });
        await prisma.user.deleteMany({ where: { tenantId } });
        await prisma.tenant.delete({ where: { id: tenantId } });
      })().catch((e: unknown) => {
        // Never mask a test's own result, but never hide a leaked tenant either.
        // eslint-disable-next-line no-console
        console.error(`move-to-credit cleanup failed for tenant ${tenantId}:`, e);
      });
    }
    await prisma?.$disconnect();
  });

  /** A tenant with one supplier and a RECEIVED $500 bill carrying one $200 CHECK payment. */
  async function seedWorld(label: string) {
    const slug = freshTenantSlug(label);
    const tenant = await prisma.tenant.create({ data: { slug, name: `Move credit ${slug}` } });
    createdTenantIds.push(tenant.id);
    const user = await prisma.user.create({
      data: {
        email: `${slug}@example.invalid`,
        username: slug,
        role: "OPERATOR",
        tenantId: tenant.id,
      },
    });
    const supplier = await prisma.supplier.create({
      data: { name: `Supplier ${slug}`, tenantId: tenant.id },
    });
    const bill = await prisma.vendorBill.create({
      data: {
        billNumber: `BILL-${slug}`,
        supplierId: supplier.id,
        status: "PARTIAL",
        totalOwed: 500,
        totalPaid: 200,
        billDate: new Date("2026-08-01T00:00:00.000Z"),
        receivedDate: new Date("2026-08-02T00:00:00.000Z"),
        tenantId: tenant.id,
      },
    });
    const payment = await prisma.billPayment.create({
      data: {
        vendorBillId: bill.id,
        amount: 200,
        method: "CHECK",
        reference: "CHK-1",
        paidAt: PAID_AT,
        tenantId: tenant.id,
      },
    });
    return {
      tenantId: tenant.id,
      userId: user.id,
      supplierId: supplier.id,
      billId: bill.id,
      paymentId: payment.id,
    };
  }

  it("turns a $200 cash payment into one dated $200 credit and returns the bill to RECEIVED", async () => {
    const w = await seedWorld("move");

    const out = await tenantCtx.run(w.tenantId, () =>
      bills.movePaymentToSupplierCredit(w.billId, w.paymentId, w.userId),
    );
    expect(out.bill.id).toBe(w.billId);

    const credits = await prisma.supplierCredit.findMany({ where: { tenantId: w.tenantId } });
    expect(credits).toHaveLength(1);
    expect(credits[0].supplierId).toBe(w.supplierId);
    expect(Number(credits[0].amount)).toBe(200);
    expect(Number(credits[0].balance)).toBe(200);
    expect(credits[0].receivedAt.getTime()).toBe(PAID_AT.getTime());
    expect(out.supplierCredit.id).toBe(credits[0].id);

    expect(await prisma.billPayment.findUnique({ where: { id: w.paymentId } })).toBeNull();
    const bill = await prisma.vendorBill.findUniqueOrThrow({ where: { id: w.billId } });
    expect(Number(bill.totalPaid)).toBe(0);
    expect(bill.status).toBe("RECEIVED");
  });

  it("refuses a second move of the same payment with a 404 and mints no second credit", async () => {
    const w = await seedWorld("again");
    await tenantCtx.run(w.tenantId, () =>
      bills.movePaymentToSupplierCredit(w.billId, w.paymentId, w.userId),
    );

    await expect(
      tenantCtx.run(w.tenantId, () =>
        bills.movePaymentToSupplierCredit(w.billId, w.paymentId, w.userId),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(await prisma.supplierCredit.count({ where: { tenantId: w.tenantId } })).toBe(1);
    const bill = await prisma.vendorBill.findUniqueOrThrow({ where: { id: w.billId } });
    expect(Number(bill.totalPaid)).toBe(0);
    expect(bill.status).toBe("RECEIVED");
  });
});
