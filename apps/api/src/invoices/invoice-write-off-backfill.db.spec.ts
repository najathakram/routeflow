/**
 * SA-1050 PR-1 (real Postgres): `ensureWriteOffEvent` and the backfill that calls it.
 *
 *   G-5:  an imported WRITTEN_OFF invoice (no writtenOffAt) gets ONE undated event (at null, byId null, reason "Imported as
 *         written off"); a second call writes nothing; an invoice that owes nothing writes no row. (A reinstate of it books
 *         today's recovery: PR-2.)
 *   G-2:  the plan counts every WRITTEN_OFF invoice and lists old and new per month; a dry run writes nothing; `apply`
 *         writes the events; a second apply writes 0; the undated row sits in no window, so the P&L figure is unchanged.
 *   G-b2: across two `qa-*` tenants, the join count of events whose tenantId differs from their invoice's is 0 after the
 *         apply (and `scripts/data-integrity-report.mjs` reports the same count as a standing read-only row).
 *
 * Runs only under `npm run local:test:db`; every tenant is a throwaway `qa-wo2-<run>-<n>` slug (`assertTestTenant`).
 */
// Prevent Jest from traversing ESM-only dependencies (same guard as invoices.service.spec.ts /
// invoice-numbering.db.spec.ts).
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
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { EstimatesService } from "../estimates/estimates.service";
import { NumberingService } from "../import/numbering.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { deleteNonBlockingInvoicesCas } from "../customers/customer-delete-preflight";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { fetchBadDebtExpense } from "../common/invoiced-sales";
import { ensureWriteOffEvent } from "./invoice-write-off";
import { applyWriteOffBackfill, planWriteOffBackfill } from "./invoice-write-off-backfill";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
/** A fresh, policy-approved throwaway tenant slug — never reused across tests in this file. */
function freshTenantSlug(label: string): string {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-wo2-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "invoice-write-off-backfill.db.spec.ts",
  );
}

describeDb("SA-1050 PR-1: ensureWriteOffEvent and the backfill (real Postgres)", () => {
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
  // flag.msrp OFF: applyMsrpSnapshots no-ops.
  const mockEntitlements = { hasFlag: jest.fn().mockResolvedValue(false) };
  const mockCommissionEngine = {
    syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined),
    syncOrderInvoices: jest.fn().mockResolvedValue(undefined),
    removeInvoiceCommission: jest.fn().mockResolvedValue(undefined),
  };

  beforeAll(async () => {
    // Nothing env-dependent may run at collection time (db-lane rule): the real connection is
    // built here, inside a hook, never at module top level.
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoicesService,
        {
          provide: SellingRestrictionsService,
          useValue: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
        },
        EstimatesService,
        NumberingService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: mockGateway },
        { provide: EmailService, useValue: mockEmailService },
        { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
        { provide: SystemConfigService, useValue: mockSystemConfig },
        {
          provide: RegulatedLedgerService,
          useValue: {
            writeSaleEntries: jest.fn(),
            reverseInvoiceEntries: jest.fn(),
            settleRegulatedLedger: jest.fn().mockResolvedValue({ written: 0, amendedPeriod: null }),
          },
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
        {
          provide: EntitlementAuthority,
          inject: [EntitlementsService],
          useFactory: (e: { hasFlag?: (t: string, k: string) => Promise<boolean> }) => ({
            can: (t: string, k: string) => e.hasFlag?.(t, k) ?? Promise.resolve(false),
          }),
        },
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
        // Best-effort: a failed cleanup must never mask a test's own pass/fail result.
      });
    }
    await prisma?.$disconnect();
  });

  async function cleanupTenant(tenantId: string): Promise<void> {
    await prisma.invoiceWriteOffEvent.deleteMany({ where: { tenantId } });
    await prisma.invoicePayment.deleteMany({ where: { tenantId } });
    await prisma.auditLog.deleteMany({ where: { tenantId } });
    await prisma.creditNote.deleteMany({ where: { tenantId } });
    await prisma.invoiceItem.deleteMany({ where: { tenantId } });
    await prisma.invoice.deleteMany({ where: { tenantId } });
    await prisma.customer.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  }

  async function seedTenant(label: string): Promise<{ id: string; slug: string }> {
    const slug = freshTenantSlug(label);
    const tenant = await prisma.tenant.create({ data: { slug, name: `wo2 ${slug}` } });
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
        businessName: `wo2 customer ${label}`,
        contactName: `wo2 contact ${label}`,
        tenantId,
      },
    });
    return { id: customer.id };
  }

  async function seedWritten(
    tenantId: string,
    customerId: string,
    label: string,
    o: { total: number; tax: number; paid?: number[]; at: Date | null },
  ) {
    const inv = await prisma.invoice.create({
      data: {
        tenantId,
        customerId,
        invoiceNumber: `INV-WO2-${RUN_SUFFIX}-${label}`,
        status: "WRITTEN_OFF",
        subtotal: o.total - o.tax,
        taxAmount: o.tax,
        total: o.total,
        writeOffReason: o.at ? "legacy write-off" : null,
        writtenOffAt: o.at,
      },
    });
    for (const amount of o.paid ?? []) {
      await prisma.invoicePayment.create({
        data: { tenantId, invoiceId: inv.id, amount, method: "CASH", status: "PAID" },
      });
    }
    return inv;
  }
  const eventsOf = (invoiceId: string) =>
    prisma.invoiceWriteOffEvent.findMany({ where: { invoiceId } });
  const WIDE = { gte: new Date("2026-01-01T00:00:00Z"), lte: new Date("2099-12-31T23:59:59.999Z") };
  const SEPT = { gte: new Date("2026-09-01T00:00:00Z"), lte: new Date("2026-09-30T23:59:59.999Z") };

  it("G-5: an imported WRITTEN_OFF invoice gets ONE undated event; a second call and an owing-nothing invoice write nothing", async () => {
    const t = await seedTenant("g5");
    const customer = await seedCustomer(t.id, "g5");
    const imported = await seedWritten(t.id, customer.id, "g5a", { total: 42, tax: 0, at: null });
    const settled = await seedWritten(t.id, customer.id, "g5b", {
      total: 30,
      tax: 0,
      paid: [30],
      at: null,
    });

    const first = await tenantCtx.run(t.id, () =>
      prisma.tenantTransaction((tx) => ensureWriteOffEvent({ prisma }, tx, imported.id)),
    );
    const second = await tenantCtx.run(t.id, () =>
      prisma.tenantTransaction((tx) => ensureWriteOffEvent({ prisma }, tx, imported.id)),
    );
    const none = await tenantCtx.run(t.id, () =>
      prisma.tenantTransaction((tx) => ensureWriteOffEvent({ prisma }, tx, settled.id)),
    );

    expect(first.written).toBe(true);
    expect(second).toEqual({ written: false, skipped: "HAS_EVENT" });
    expect(none).toEqual({ written: false, skipped: "NOTHING_DUE" });
    const events = await eventsOf(imported.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "WRITE_OFF",
      tenantId: t.id,
      at: null,
      byId: null,
      reason: "Imported as written off",
    });
    expect(Number(events[0].amount)).toBe(42);
    expect(await eventsOf(settled.id)).toHaveLength(0);
    // Undated: in no window, so the expense reads exactly what it read before (0).
    expect(await tenantCtx.run(t.id, () => fetchBadDebtExpense(prisma as any, t.id, WIDE))).toBe(0);
  }, 60_000);

  it("G-2 / G-b2: plan, dry run writes nothing, apply, a second apply writes 0, no cross-tenant row, P&L unchanged", async () => {
    const a = await seedTenant("bfa");
    const b = await seedTenant("bfb");
    const custA = await seedCustomer(a.id, "bfa");
    const custB = await seedCustomer(b.id, "bfb");
    const sept = new Date("2026-09-15T12:00:00Z");
    // tenant A: a dated 107.00 (tax 7.00) with 53.50 paid, an undated one, and one that owes nothing
    const dated = await seedWritten(a.id, custA.id, "bf1", {
      total: 107,
      tax: 7,
      paid: [53.5],
      at: sept,
    });
    const undated = await seedWritten(a.id, custA.id, "bf2", { total: 20, tax: 0, at: null });
    await seedWritten(a.id, custA.id, "bf3", { total: 15, tax: 0, paid: [15], at: sept });
    // tenant B: a dated 10.70 (tax 0.70) with 0.03 paid
    const bDated = await seedWritten(b.id, custB.id, "bf4", {
      total: 10.7,
      tax: 0.7,
      paid: [0.03],
      at: sept,
    });

    const before = {
      a: await tenantCtx.run(a.id, () => fetchBadDebtExpense(prisma as any, a.id, SEPT)),
      b: await tenantCtx.run(b.id, () => fetchBadDebtExpense(prisma as any, b.id, SEPT)),
    };

    const planA = await planWriteOffBackfill(prisma as any, { tenantId: a.id });
    const planB = await planWriteOffBackfill(prisma as any, { tenantId: b.id });
    expect(planA.scanned).toBe(3);
    expect(planA.invoiceIds.sort()).toEqual([dated.id, undated.id].sort());
    expect(planA.nothingDue).toBe(1);
    expect(planA.nullTenant).toBe(0);
    const septA = planA.months.find((m) => m.month === "2026-09")!;
    expect(septA).toMatchObject({ invoices: 1, oldExpense: 50, newExpense: 50 });
    expect(planA.months.find((m) => m.month === "undated")).toMatchObject({ invoices: 1 });
    expect(planB.months).toEqual([
      { tenantId: b.id, month: "2026-09", invoices: 1, oldExpense: 9.97, newExpense: 9.97 },
    ]);
    // the dry run (the plan) wrote nothing
    expect(
      await prisma.invoiceWriteOffEvent.count({ where: { tenantId: { in: [a.id, b.id] } } }),
    ).toBe(0);

    const first = await applyWriteOffBackfill(prisma as any, [
      ...planA.invoiceIds,
      ...planB.invoiceIds,
    ]);
    expect(first).toEqual({ written: 3, skipped: 0, failed: [] });
    const again = await applyWriteOffBackfill(prisma as any, [
      ...planA.invoiceIds,
      ...planB.invoiceIds,
    ]);
    expect(again).toEqual({ written: 0, skipped: 3, failed: [] });
    expect((await planWriteOffBackfill(prisma as any, { tenantId: a.id })).invoiceIds).toEqual([]);

    // G-b2: the join count of events whose tenantId differs from their invoice's (the integrity report's row)
    const mismatched: Array<{ n: bigint }> = await prisma.$queryRaw`
      SELECT count(*) AS n FROM "InvoiceWriteOffEvent" e JOIN "Invoice" p ON p.id = e."invoiceId"
       WHERE e."tenantId" IS DISTINCT FROM p."tenantId"
         AND e."tenantId" IN (${a.id}, ${b.id})`;
    expect(Number(mismatched[0].n)).toBe(0);
    expect((await eventsOf(bDated.id))[0].tenantId).toBe(b.id);
    expect((await eventsOf(undated.id))[0]).toMatchObject({ at: null, tenantId: a.id });

    // the P&L figure is unchanged: the dated rows are read from the ledger now, the undated one sits in no window
    const after = {
      a: await tenantCtx.run(a.id, () => fetchBadDebtExpense(prisma as any, a.id, SEPT)),
      b: await tenantCtx.run(b.id, () => fetchBadDebtExpense(prisma as any, b.id, SEPT)),
    };
    expect(after).toEqual(before);
    expect(await tenantCtx.run(a.id, () => fetchBadDebtExpense(prisma as any, a.id, WIDE))).toBe(
      50,
    );
  }, 120_000);
});
