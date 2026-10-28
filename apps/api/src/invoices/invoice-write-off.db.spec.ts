/**
 * SA-1050 PR-1 (real Postgres): the write-off is the first WRITER of the bad-debt ledger.
 *
 *   R-7:  write-off of an open invoice whose confirmedBalance is 0 (overpaid): master books 200 and a 0 expense; now 409
 *         WRITE_OFF_NOTHING_DUE and nothing changes.
 *   G-6:  a replayed write-off: master answers 400 "Cannot write off ... WRITTEN_OFF"; now 409 INVOICE_ALREADY_WRITTEN_OFF
 *         and no second event.
 *   Happy path: one WRITE_OFF event (amount = confirmedBalance, preTax = badDebtPreTax, at = writtenOffAt, byId = actor),
 *         Invoice.writtenOffById, one 'invoice.written_off' audit row, in the one transaction.
 *   Rule 4: fetchBadDebtExpense reads events in the window plus a legacy term (no event), per-invoice rounding.
 *
 * Runs only under `npm run local:test:db`; every tenant is a throwaway `qa-wo1-<run>-<n>` slug (`assertTestTenant`).
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

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
/** A fresh, policy-approved throwaway tenant slug — never reused across tests in this file. */
function freshTenantSlug(label: string): string {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-wo1-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "invoice-write-off.db.spec.ts",
  );
}

describeDb("SA-1050 PR-1: the write-off writes its event (real Postgres)", () => {
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
    const tenant = await prisma.tenant.create({ data: { slug, name: `wo1 ${slug}` } });
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
        businessName: `wo1 customer ${label}`,
        contactName: `wo1 contact ${label}`,
        tenantId,
      },
    });
    return { id: customer.id };
  }

  async function seedActor(tenantId: string, label: string): Promise<{ id: string }> {
    const slug = `${tenantId}-actor-${label}`;
    const user = await prisma.user.create({
      data: { email: `${slug}@example.invalid`, username: slug, role: "OPERATOR", tenantId },
    });
    return { id: user.id };
  }

  /** An open invoice: total, tax, and PAID payments of the given amounts (confirmed). */
  async function seedOpen(
    tenantId: string,
    customerId: string,
    label: string,
    o: { total: number; tax: number; paid?: number[]; status?: "SENT" | "PARTIAL" },
  ) {
    const inv = await prisma.invoice.create({
      data: {
        tenantId,
        customerId,
        invoiceNumber: `INV-WO1-${RUN_SUFFIX}-${label}`,
        status: o.status ?? "SENT",
        subtotal: o.total - o.tax,
        taxAmount: o.tax,
        total: o.total,
      },
    });
    for (const amount of o.paid ?? []) {
      await prisma.invoicePayment.create({
        data: { tenantId, invoiceId: inv.id, amount, method: "CASH", status: "PAID" },
      });
    }
    return inv;
  }

  const DTO = { reason: "uncollectable" };
  const writeOff = (id: string, actorId: string | null) =>
    invoicesService.writeOff(id, DTO, actorId);
  const eventsOf = (invoiceId: string) =>
    prisma.invoiceWriteOffEvent.findMany({ where: { invoiceId } });

  it("R-7: a write-off with a confirmedBalance of 0 (overpaid open invoice) is 409 WRITE_OFF_NOTHING_DUE", async () => {
    const t = await seedTenant("r7");
    const customer = await seedCustomer(t.id, "r7");
    const actor = await seedActor(t.id, "r7");
    const inv = await seedOpen(t.id, customer.id, "r7", { total: 50, tax: 0, paid: [60] });

    const res: any = await tenantCtx
      .run(t.id, () => writeOff(inv.id, actor.id))
      .catch((e: unknown) => e);

    // head: resolves with the written-off invoice (200) and books 0.
    expect(res?.getStatus?.()).toBe(409);
    expect(res.getResponse()).toMatchObject({ code: "WRITE_OFF_NOTHING_DUE" });
    const after = await prisma.invoice.findUnique({ where: { id: inv.id } });
    expect(after?.status).toBe("SENT");
    expect(await eventsOf(inv.id)).toHaveLength(0);
  }, 60_000);

  it("happy path: one WRITE_OFF event, the actor on the invoice, one audit row", async () => {
    const t = await seedTenant("ok");
    const customer = await seedCustomer(t.id, "ok");
    const actor = await seedActor(t.id, "ok");
    const inv = await seedOpen(t.id, customer.id, "ok", {
      total: 107,
      tax: 7,
      paid: [53.5],
      status: "PARTIAL",
    });

    const written: any = await tenantCtx.run(t.id, () => writeOff(inv.id, actor.id));

    expect(written.status).toBe("WRITTEN_OFF");
    const stored = await prisma.invoice.findUnique({ where: { id: inv.id } });
    expect(stored?.writtenOffById).toBe(actor.id);
    const events = await eventsOf(inv.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "WRITE_OFF",
      tenantId: t.id,
      byId: actor.id,
      reason: DTO.reason,
    });
    expect(Number(events[0].amount)).toBe(53.5);
    expect(Number(events[0].preTax)).toBe(50);
    expect(events[0].at?.getTime()).toBe(stored?.writtenOffAt?.getTime());
    const audit = await prisma.auditLog.findMany({
      where: { entityType: "invoice", entityId: inv.id, action: "invoice.written_off" },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0].userId).toBe(actor.id);
    expect(audit[0].meta).toMatchObject({ amount: 53.5, preTax: 50, reason: DTO.reason });
  }, 60_000);

  it("G-6: a replayed write-off is 409 INVOICE_ALREADY_WRITTEN_OFF and writes no second event", async () => {
    const t = await seedTenant("g6");
    const customer = await seedCustomer(t.id, "g6");
    const actor = await seedActor(t.id, "g6");
    const inv = await seedOpen(t.id, customer.id, "g6", { total: 40, tax: 0 });
    await tenantCtx.run(t.id, () => writeOff(inv.id, actor.id));

    const res: any = await tenantCtx
      .run(t.id, () => writeOff(inv.id, actor.id))
      .catch((e: unknown) => e);

    // head: 400 "Cannot write off an invoice with status WRITTEN_OFF".
    expect(res?.getStatus?.()).toBe(409);
    expect(res.getResponse()).toMatchObject({ code: "INVOICE_ALREADY_WRITTEN_OFF" });
    expect(await eventsOf(inv.id)).toHaveLength(1);
  }, 60_000);

  it("rule 4: fetchBadDebtExpense = Σ preTax of events in the window + the legacy term, per-invoice rounded", async () => {
    const t = await seedTenant("exp");
    const customer = await seedCustomer(t.id, "exp");
    const actor = await seedActor(t.id, "exp");
    // Three legacy written-off invoices (no event): 10.70 (tax 0.70), 0.03 confirmed. Sum-then-round says 29.92;
    // per invoice 9.97 x 3 = 29.91.
    const at = new Date("2026-09-15T12:00:00Z");
    for (let i = 0; i < 3; i++) {
      const inv = await seedOpen(t.id, customer.id, `leg${i}`, {
        total: 10.7,
        tax: 0.7,
        paid: [0.03],
      });
      await prisma.invoice.update({
        where: { id: inv.id },
        data: { status: "WRITTEN_OFF", writeOffReason: "legacy", writtenOffAt: at },
      });
    }
    // One real write-off today (an event), inside a wider window than September.
    const live = await seedOpen(t.id, customer.id, "live", {
      total: 107,
      tax: 7,
      paid: [53.5],
      status: "PARTIAL",
    });
    await tenantCtx.run(t.id, () => writeOff(live.id, actor.id));

    const september = {
      gte: new Date("2026-09-01T00:00:00Z"),
      lt: new Date("2026-10-01T00:00:00Z"),
    };
    const wide = { gte: new Date("2026-01-01T00:00:00Z"), lt: new Date("2100-01-01T00:00:00Z") };
    const sept = await tenantCtx.run(t.id, () =>
      fetchBadDebtExpense(prisma as any, t.id, september),
    );
    const all = await tenantCtx.run(t.id, () => fetchBadDebtExpense(prisma as any, t.id, wide));

    expect(sept).toBe(29.91); // head: 29.92
    expect(all).toBe(79.91); // 29.91 legacy + 50.00 the event; the evented invoice is not counted twice
  }, 60_000);
});
