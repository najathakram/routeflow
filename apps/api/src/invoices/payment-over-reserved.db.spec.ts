/**
 * NEED-DB (W-706, SA-862): a CAPTURED payment that over-reserves an invoice is SIGNALLED, never refused; the later
 * confirm of the unconfirmed row gets a coded 409. RED first: on master there is no audit row, no `overReserved`
 * flag and the confirm answers 400 "exceeds remaining balance" (observe-and-report).
 * Run on an `rf_dbspec_*` database: `npm run local:test:db` (invoices + payment-requests lanes).
 *
 *  - R1: captured settle on an invoice carrying a DRAFT for the full amount -> invoice PAID by the card row;
 *        exactly 1 PAYMENT_UNCONFIRMED_OVER_RESERVED audit row naming the DRAFT; `capture.overReserved` has 1 entry.
 *  - R2: confirming that DRAFT -> 409 UNCONFIRMED_PAYMENT_SUPERSEDED, nothing written.
 *  - R3: a captured settle with no unconfirmed rows -> no audit row, empty `overReserved`.
 *  - R4: a rolled-back captured attempt, then the retry -> exactly one entry / one audit row (from the commit).
 *  - R5: a PENDING post-dated check + a card settle -> as R1 with the PENDING id.
 * SAFETY: throwaway `qa-w706-<run>-<n>-<label>` tenants only (`assertTestTenant`); `afterAll` deletes what it made.
 */

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
import { withAdvisoryLock } from "../common/db-locks";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
function freshTenantSlug(label: string): string {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-w706-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "payment-over-reserved.db.spec.ts",
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

describeDb("W-706 captured payment over-reserves an invoice — real Postgres", () => {
  let tenantCtx: TenantContextService;
  let prisma: PrismaService;
  let invoices: InvoicesService;
  const createdTenantIds: string[] = [];

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    invoices = await buildInvoices(prisma, tenantCtx);
  });

  afterAll(async () => {
    for (const tenantId of createdTenantIds) {
      // eslint-disable-next-line no-await-in-loop
      await cleanupTenant(tenantId).catch(() => undefined);
    }
    await prisma?.$disconnect();
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

  /** A tenant with one $1000 SENT invoice, optionally carrying one unconfirmed row for the full amount. */
  async function seed(label: string, unconfirmed?: "DRAFT" | "PENDING") {
    const slug = freshTenantSlug(label);
    const tenant = await prisma.tenant.create({ data: { slug, name: `W706 ${slug}` } });
    createdTenantIds.push(tenant.id);
    const user = await prisma.user.create({
      data: {
        email: `c-${tenant.id}@example.invalid`,
        username: `c-${tenant.id}`,
        role: "CUSTOMER",
        tenantId: tenant.id,
      },
    });
    const customer = await prisma.customer.create({
      data: { userId: user.id, businessName: "W706 a", contactName: "W706 a", tenantId: tenant.id },
    });
    const invoice = await prisma.invoice.create({
      data: {
        tenantId: tenant.id,
        customerId: customer.id,
        invoiceNumber: `INV-W706-${randomUUID().slice(0, 8)}`,
        status: "SENT",
        subtotal: 1000,
        total: 1000,
      },
    });
    const row = unconfirmed
      ? await prisma.invoicePayment.create({
          data: {
            tenantId: tenant.id,
            invoiceId: invoice.id,
            amount: 1000,
            method: "CHECK",
            status: unconfirmed as any,
            paidAt: new Date("2026-10-01"),
            paymentNumber: `PAY-W706-${randomUUID().slice(0, 8)}`,
            reference: "CHK-W706",
          } as any,
        })
      : null;
    const asTenant = <T>(fn: () => Promise<T>) => tenantCtx.run(tenant.id, fn);
    const capture = () => ({
      source: "STRIPE" as const,
      sourceRef: `pi_w706_${randomUUID().slice(0, 8)}`,
      suspects: [] as any[],
      overReserved: [] as any[],
    });
    const settle = (cap: ReturnType<typeof capture>, extra: Record<string, unknown> = {}) =>
      asTenant(() =>
        invoices.recordStandalonePayment(
          {
            customerId: customer.id,
            totalAmount: 1000,
            method: "CREDIT_CARD",
            reference: cap.sourceRef,
            allocations: [{ invoiceId: invoice.id, amount: 1000 }],
          } as any,
          { capturedExternally: cap, ...extra } as any,
        ),
      );
    const overReservedAudits = () =>
      prisma.auditLog.findMany({
        where: { tenantId: tenant.id, action: "payment.unconfirmed-over-reserved" },
      });
    return { tenant, customer, invoice, row, asTenant, capture, settle, overReservedAudits };
  }

  it("R1 a card settle on an invoice with a full-amount DRAFT: PAID, one audit row naming the DRAFT, one overReserved entry", async () => {
    const s = await seed("r1", "DRAFT");
    const cap = s.capture();
    await s.settle(cap);
    const inv = await prisma.invoice.findUnique({ where: { id: s.invoice.id } });
    expect(inv?.status).toBe("PAID");
    const audits = await s.overReservedAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0].meta).toMatchObject({ unconfirmedPaymentIds: [s.row!.id], excess: 1000 });
    expect(cap.overReserved).toEqual([
      expect.objectContaining({
        invoiceId: s.invoice.id,
        unconfirmedPaymentIds: [s.row!.id],
        excess: 1000,
      }),
    ]);
  }, 60_000);

  it("R2 confirming that DRAFT afterwards is 409 UNCONFIRMED_PAYMENT_SUPERSEDED and writes nothing", async () => {
    const s = await seed("r2", "DRAFT");
    await s.settle(s.capture());
    const err: any = await s
      .asTenant(() =>
        invoices.updatePayment(s.invoice.id, s.row!.id, {
          amount: 1000,
          method: "CHECK",
          status: "PAID",
          reference: "CHK-W706",
          paidAt: "2026-10-01",
        } as any),
      )
      .catch((e) => e);
    expect(err.getStatus()).toBe(409);
    expect(err.getResponse()).toMatchObject({ code: "UNCONFIRMED_PAYMENT_SUPERSEDED" });
    const after = await prisma.invoicePayment.findUnique({ where: { id: s.row!.id } });
    expect(after?.status).toBe("DRAFT");
  }, 60_000);

  it("R3 (guard) a card settle with no unconfirmed rows writes no audit row and flags nothing", async () => {
    const s = await seed("r3");
    const cap = s.capture();
    await s.settle(cap);
    expect(await s.overReservedAudits()).toHaveLength(0);
    expect(cap.overReserved).toHaveLength(0);
  }, 60_000);

  it("R4 a rolled-back captured attempt, then its retry: exactly one entry and one audit row", async () => {
    const s = await seed("r4", "DRAFT");
    const cap = s.capture();
    let boom = true;
    await s.settle(cap, {
      inTx: async () => {
        if (boom) {
          boom = false;
          const e: any = new Error("deadlock detected");
          e.code = "40P01";
          throw e;
        }
      },
    });
    expect(boom).toBe(false); // the first attempt really ran and rolled back
    expect(await s.overReservedAudits()).toHaveLength(1);
    expect(cap.overReserved).toHaveLength(1);
  }, 60_000);

  it("R5 a PENDING post-dated check plus a card settle: as R1 with the PENDING id", async () => {
    const s = await seed("r5", "PENDING");
    const cap = s.capture();
    await s.settle(cap);
    const audits = await s.overReservedAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0].meta).toMatchObject({ unconfirmedPaymentIds: [s.row!.id] });
    expect(cap.overReserved).toHaveLength(1);
  }, 60_000);
});
