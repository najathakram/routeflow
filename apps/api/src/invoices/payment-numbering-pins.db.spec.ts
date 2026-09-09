/**
 * TP-DB / T2 (green half) — the PIN-B269 regression guards for payment numbering.
 *
 * WHY A SEPARATE FILE: `payment-numbering.db.spec.ts` is the RED-GATE file for
 * REG-B269 — every test in it must fail on today's code on its own predicted
 * wrong value. T2d is the opposite: the bug-test-plan declares it GREEN today
 * AND after the fix (sites 1/2 already embed the `tenantShort` segment; D3 does
 * not change their format). Keeping a passing test in the repro file made the
 * red gate report "not all red" for a test that was never supposed to be red, so
 * the plan-sanctioned green pin lives here instead. Design of record:
 * `.claude/pipeline/2026-09-08-numbering-siblings/cause-ruling.md` §2 (D3);
 * plan `bug-test-plan.md` T2d.
 *
 * WHY THE DB LANE (L-061): the pin asserts the number a REAL `PaymentCounter`
 * upsert produces for a fresh tenant, which a mocked counter cannot establish.
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`), run via
 * `npm run local:test:db`; `requireLocalDatabaseUrl()` refuses any non-local host.
 *
 * SAFETY: every tenant this file creates is a throwaway `qa-b269p-<run>-<n>-<label>`
 * slug, approved by `assertTestTenant`. `afterAll` deletes exactly the tenants
 * THIS run created (FK order: AdvancePayment → InvoicePayment → Invoice →
 * PaymentCounter(by tenant id) → Customer → User → Tenant).
 */

// Prevent Jest from traversing ESM-only dependencies (same guard as
// payment-numbering.db.spec.ts — InvoicesService imports these).
jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({
  compressDocument: jest.fn(),
}));

import { Test, TestingModule } from "@nestjs/testing";
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
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { NumberingService } from "../import/numbering.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
/** A fresh, policy-approved throwaway tenant slug — never reused across tests in this file. */
function freshTenantSlug(label: string): string {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-b269p-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "payment-numbering-pins.db.spec.ts",
  );
}

/** Matches sites 1/2's `counterKey.slice(0, 6).toUpperCase()` exactly. */
function tenantShort(tenantId: string): string {
  return tenantId.slice(0, 6).toUpperCase();
}

describeDb("B269 payment numbering — green regression pins (T2d)", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let invoicesService: InvoicesService;
  const createdTenantIds: string[] = [];

  const mockGateway = {
    emitInvoiceUpdated: jest.fn(),
    emitOrderCreated: jest.fn(),
    emitOrderStatusChanged: jest.fn(),
    emitLowStock: jest.fn(),
    emitStopCompleted: jest.fn(),
    emitUrgentOrder: jest.fn(),
  };
  const mockEmailService = {
    sendInvoice: jest.fn().mockResolvedValue({ delivered: true, transport: "resend" }),
    isEmailConfigured: jest.fn().mockResolvedValue(true),
  };
  const mockSystemConfig = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
  };
  const mockCreditNotes = {
    autoApplyOldestCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, invoiceStatus: null }),
    settleOrderCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, unapplied: 0 }),
    releaseInvoiceCreditsInTx: jest.fn().mockResolvedValue([]),
  };
  const mockMessaging = {
    notify: jest.fn().mockResolvedValue([]),
    notifyEvent: jest.fn().mockResolvedValue(undefined),
  };
  const mockStorage = {
    upload: jest.fn().mockResolvedValue("stored"),
    presignedUrl: jest.fn().mockResolvedValue("https://signed/url"),
    delete: jest.fn().mockResolvedValue(undefined),
  };
  const mockEntitlements = { hasFlag: jest.fn().mockResolvedValue(false) };
  const mockCommissionEngine = {
    syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined),
    syncOrderInvoices: jest.fn().mockResolvedValue(undefined),
    removeInvoiceCommission: jest.fn().mockResolvedValue(undefined),
  };

  beforeAll(async () => {
    // Nothing env-dependent may run at collection time (db-lane.db.spec.ts's rule): the real
    // connection is built here, inside a hook, never at module top level.
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoicesService,
        NumberingService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: mockGateway },
        { provide: EmailService, useValue: mockEmailService },
        { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
        { provide: SystemConfigService, useValue: mockSystemConfig },
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
        { provide: CreditNotesService, useValue: mockCreditNotes },
        { provide: MessagingService, useValue: mockMessaging },
        { provide: StorageService, useValue: mockStorage },
        { provide: EntitlementsService, useValue: mockEntitlements },
        { provide: CommissionEngineService, useValue: mockCommissionEngine },
      ],
    }).compile();

    invoicesService = module.get(InvoicesService);
  });

  afterAll(async () => {
    for (const tenantId of createdTenantIds) {
      // eslint-disable-next-line no-await-in-loop
      await cleanupTenant(tenantId).catch(() => {
        // Best-effort: a failed cleanup must never mask the test's own pass/fail result.
      });
    }
    await prisma?.$disconnect();
  });

  async function cleanupTenant(tenantId: string): Promise<void> {
    await prisma.advancePayment.deleteMany({ where: { tenantId } });
    await prisma.invoicePayment.deleteMany({ where: { invoice: { tenantId } } });
    await prisma.invoice.deleteMany({ where: { tenantId } });
    // Sites 1/3 key their counter row by the ambient tenantId (never "singleton" once a
    // context exists) — id equals the tenant id we created.
    await prisma.paymentCounter.deleteMany({ where: { id: tenantId } });
    await prisma.customer.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  }

  async function seedTenant(label: string): Promise<{ id: string; slug: string }> {
    const slug = freshTenantSlug(label);
    const tenant = await prisma.tenant.create({ data: { slug, name: `B269 ${slug}` } });
    createdTenantIds.push(tenant.id);
    return { id: tenant.id, slug };
  }

  async function seedCustomer(tenantId: string, label: string): Promise<{ id: string }> {
    const idBase = `${tenantId}-${label}`;
    const user = await prisma.user.create({
      data: {
        email: `${idBase}@example.invalid`,
        username: idBase,
        role: "CUSTOMER",
        tenantId,
      },
    });
    const customer = await prisma.customer.create({
      data: {
        userId: user.id,
        businessName: `B269 customer ${label}`,
        contactName: `B269 contact ${label}`,
        tenantId,
      },
    });
    return { id: customer.id };
  }

  async function seedInvoice(tenantId: string, customerId: string, total: number) {
    return prisma.invoice.create({
      data: {
        tenantId,
        customerId,
        invoiceNumber: `INV-SEED-${randomUUID().slice(0, 8)}`,
        status: "SENT",
        subtotal: total,
        total,
      },
    });
  }

  it("T2d PIN-B269-D (GREEN today and after — sites 1/2's format is unchanged): recordPayment (site 1) still mints PAY-<tenantShort>-0001 for a fresh tenant", async () => {
    const tenantA = await seedTenant("t2d-a");
    const custA = await seedCustomer(tenantA.id, "a");
    const invoiceA = await seedInvoice(tenantA.id, custA.id, 100);

    const paid = await tenantCtx.run(tenantA.id, () =>
      invoicesService.recordPayment(invoiceA.id, { amount: 10, method: "CASH" } as any),
    );

    const payment = (paid as any).payments.find(
      (p: any) => p.id === (paid as any).createdPaymentId,
    );
    expect(payment?.paymentNumber).toBe(`PAY-${tenantShort(tenantA.id)}-0001`);
  }, 30_000);
});
