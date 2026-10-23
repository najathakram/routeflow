/**
 * NEED-DB (row 2299, SA-858): payment CAPACITY against real Postgres. CAPACITY = every non-VOID row (DRAFT + PAID +
 * PENDING). Run with the invoices + bookkeeping + payment-requests DB lanes (`npm run local:test:db`).
 *
 *  - R1: recordPayment DRAFT on an invoice whose PAID rows cover the total is 400 FULLY_PAID, nothing written.
 *  - R2: recordPayment DRAFT above the remaining capacity is 400 EXCEEDS.
 *  - R3: an office standalone payment (not capturedExternally) with one allocation above that invoice's capacity is
 *        a 400 naming the invoice; the whole group rolls back, no advance.
 *  - R4: a bookkeeping ledger payment where a DRAFT reserves the remainder is 400 RESERVED_BY_UNCONFIRMED.
 *
 * SAFETY: throwaway `qa-r2299-<run>-<n>-<label>` tenants only (`assertTestTenant`); `afterAll` deletes what it made.
 */

// BookkeepingService pulls ESM-only chains in (as payment-ref-dedupe.bookkeeping.spec.ts mocks them)
jest.mock("@anthropic-ai/sdk", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("../bookkeeping/invoice.service", () => ({
  InvoiceService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("../vendor-bills/vendor-bills.service", () => ({
  VendorBillsService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({
  compressDocument: jest.fn(),
}));

import { Test } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { InvoicesService } from "./invoices.service";
import { InvoicePdfService } from "./invoice-pdf.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { EmailService } from "../email/email.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { MessagingService } from "../messaging/messaging.service";
import { StorageService } from "../storage/storage.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { NumberingService } from "../import/numbering.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { _resetLockPoolForTests } from "../common/db-locks";
import { BookkeepingService } from "../bookkeeping/bookkeeping.service";
import { InvoiceService } from "../bookkeeping/invoice.service";
import { VendorBillsService } from "../vendor-bills/vendor-bills.service";
import { PlatformConfigService } from "../platform-admin/platform-config.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
function freshTenantSlug(label: string): string {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-r2299-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "payment-capacity.db.spec.ts",
  );
}

/** One InvoicesService on its OWN PrismaService (its own pool = its own connections). */
async function buildInvoices(prisma: PrismaService, tenantCtx: TenantContextService) {
  const module = await Test.createTestingModule({
    providers: [
      InvoicesService,
      NumberingService,
      {
        provide: SellingRestrictionsService,
        useValue: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
      },
      { provide: PrismaService, useValue: prisma },
      { provide: TenantContextService, useValue: tenantCtx },
      { provide: RouteFlowGateway, useValue: { emitInvoiceUpdated: jest.fn() } },
      { provide: EmailService, useValue: { sendInvoice: jest.fn(), isEmailConfigured: jest.fn() } },
      { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
      {
        provide: SystemConfigService,
        useValue: { get: jest.fn().mockResolvedValue(null), set: jest.fn() },
      },
      {
        provide: RegulatedLedgerService,
        useValue: { writeSaleEntries: jest.fn(), reverseInvoiceEntries: jest.fn() },
      },
      {
        provide: AuthorizationGuardService,
        useValue: {
          assertAuthorizedOrThrow: jest.fn().mockResolvedValue(undefined),
          checkAuthorized: jest.fn().mockResolvedValue({ blocked: [] }),
        },
      },
      {
        provide: CreditNotesService,
        useValue: {
          autoApplyOldestCreditsInTx: jest
            .fn()
            .mockResolvedValue({ applied: 0, invoiceStatus: null }),
          releaseInvoiceCreditsInTx: jest.fn().mockResolvedValue([]),
        },
      },
      {
        provide: MessagingService,
        useValue: { notify: jest.fn().mockResolvedValue([]), notifyEvent: jest.fn() },
      },
      { provide: StorageService, useValue: {} },
      { provide: EntitlementAuthority, useValue: { can: jest.fn().mockResolvedValue(false) } },
      { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
      {
        provide: CommissionEngineService,
        useValue: { syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined) },
      },
    ],
  }).compile();
  return module.get(InvoicesService);
}

const status = (e: any) => (typeof e?.getStatus === "function" ? e.getStatus() : "ok");

async function buildBookkeeping(prisma: PrismaService) {
  const module = await Test.createTestingModule({
    providers: [
      BookkeepingService,
      { provide: PrismaService, useValue: prisma },
      { provide: InvoiceService, useValue: {} },
      { provide: StorageService, useValue: {} },
      { provide: VendorBillsService, useValue: {} },
      {
        provide: SystemConfigService,
        useValue: { get: jest.fn(), set: jest.fn(), getAll: jest.fn() },
      },
      { provide: PlatformConfigService, useValue: {} },
      {
        provide: CommissionEngineService,
        useValue: { syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined) },
      },
    ],
  }).compile();
  return module.get(BookkeepingService);
}

describeDb("row 2299 payment capacity — real Postgres", () => {
  let tenantCtx: TenantContextService;
  let prisma: PrismaService;
  let invoices: InvoicesService;
  let bookkeeping: BookkeepingService;
  const createdTenantIds: string[] = [];

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    invoices = await buildInvoices(prisma, tenantCtx);
    bookkeeping = await buildBookkeeping(prisma);
  });

  afterAll(async () => {
    for (const tenantId of createdTenantIds) {
      // eslint-disable-next-line no-await-in-loop
      await cleanupTenant(tenantId).catch(() => undefined);
    }
    await prisma?.$disconnect();
    await _resetLockPoolForTests(); // the payment-ref lock pool, or jest never exits
  });

  async function cleanupTenant(tenantId: string): Promise<void> {
    await prisma.auditLog.deleteMany({ where: { tenantId } });
    await prisma.paymentIdempotencyKey.deleteMany({ where: { tenantId } });
    await prisma.advancePayment.deleteMany({ where: { tenantId } });
    await prisma.invoicePayment.deleteMany({ where: { invoice: { tenantId } } });
    await prisma.invoice.deleteMany({ where: { tenantId } });
    await prisma.paymentCounter.deleteMany({ where: { id: tenantId } });
    await prisma.customer.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  }

  /** A tenant, one account customer with two open $100 invoices. */
  async function seed(label: string) {
    const slug = freshTenantSlug(label);
    const tenant = await prisma.tenant.create({ data: { slug, name: `R2299 ${slug}` } });
    createdTenantIds.push(tenant.id);
    const buyer = await prisma.user.create({
      data: {
        email: `a-${tenant.id}@example.invalid`,
        username: `a-${tenant.id}`,
        role: "CUSTOMER",
        tenantId: tenant.id,
      },
    });
    const customer = await prisma.customer.create({
      data: {
        userId: buyer.id,
        businessName: "R2299 a",
        contactName: "R2299 a",
        tenantId: tenant.id,
      },
    });
    const invs: { id: string; invoiceNumber: string }[] = [];
    for (let i = 0; i < 2; i++)
      // eslint-disable-next-line no-await-in-loop
      invs.push(
        await prisma.invoice.create({
          data: {
            tenantId: tenant.id,
            customerId: customer.id,
            invoiceNumber: `INV-R2299-${randomUUID().slice(0, 8)}-${i}`,
            status: "SENT",
            subtotal: 100,
            total: 100,
          },
        }),
      );
    const asTenant = <T>(fn: () => Promise<T>) => tenantCtx.run(tenant.id, fn);
    const row = (invoiceId: string, amount: number, status: string) =>
      prisma.invoicePayment.create({
        data: {
          invoiceId,
          tenantId: tenant.id,
          amount,
          method: "CASH",
          status,
          paidAt: new Date("2026-10-01T12:00:00Z"),
        } as any,
      });
    const count = (invoiceId: string) => prisma.invoicePayment.count({ where: { invoiceId } });
    return { tenant, customer, invs, asTenant, row, count };
  }

  it("R1 a DRAFT recorded on an invoice already fully PAID is 400 FULLY_PAID; nothing written", async () => {
    const s = await seed("r1");
    await s.row(s.invs[0].id, 100, "PAID");
    const err = await s
      .asTenant(() =>
        invoices.recordPayment(s.invs[0].id, {
          amount: 10,
          method: "CASH",
          status: "DRAFT",
          paidAt: "2026-10-02",
        } as any),
      )
      .catch((e) => e);
    expect(status(err)).toBe(400);
    expect(err.message).toBe("Invoice is already fully paid");
    expect(await s.count(s.invs[0].id)).toBe(1);
  }, 60_000);

  it("R2 a DRAFT above the remaining capacity (total 100, PAID 60, DRAFT 50) is 400 EXCEEDS", async () => {
    const s = await seed("r2");
    await s.row(s.invs[0].id, 60, "PAID");
    const err = await s
      .asTenant(() =>
        invoices.recordPayment(s.invs[0].id, {
          amount: 50,
          method: "CASH",
          status: "DRAFT",
          paidAt: "2026-10-02",
        } as any),
      )
      .catch((e) => e);
    expect(status(err)).toBe(400);
    expect(err.message).toMatch(/^Payment exceeds remaining balance of /);
    expect(await s.count(s.invs[0].id)).toBe(1);
  }, 60_000);

  it("R3 an office standalone allocation above one invoice's capacity is 400 naming it; the whole group rolls back", async () => {
    const s = await seed("r3");
    await s.row(s.invs[1].id, 90, "DRAFT"); // invoice 2 has 10 of capacity left
    const err: any = await s
      .asTenant(() =>
        invoices.recordStandalonePayment({
          customerId: s.customer.id,
          totalAmount: 80,
          method: "CASH",
          paidAt: "2026-10-02",
          allocations: [
            { invoiceId: s.invs[0].id, amount: 50 },
            { invoiceId: s.invs[1].id, amount: 30 },
          ],
        } as any),
      )
      .catch((e) => e);
    expect(status(err)).toBe(400);
    expect(String(err.message)).toContain(s.invs[1].invoiceNumber);
    expect(await s.count(s.invs[0].id)).toBe(0); // rolled back with the group
    expect(await s.count(s.invs[1].id)).toBe(1); // only the seeded DRAFT
    expect(await prisma.advancePayment.count({ where: { tenantId: s.tenant.id } })).toBe(0);
  }, 60_000);

  it("R4 a bookkeeping payment where a DRAFT reserves the rest is 400 RESERVED_BY_UNCONFIRMED", async () => {
    const s = await seed("r4");
    await s.row(s.invs[0].id, 60, "PAID");
    await s.row(s.invs[0].id, 40, "DRAFT");
    const err = await s
      .asTenant(() =>
        bookkeeping.recordPayment(s.invs[0].id, { amount: 10, method: "CASH" } as any),
      )
      .catch((e) => e);
    expect(status(err)).toBe(400);
    expect(err.message).toBe(
      "Invoice's remaining balance is already reserved by unconfirmed payments",
    );
    expect(await s.count(s.invs[0].id)).toBe(2);
  }, 60_000);
});
