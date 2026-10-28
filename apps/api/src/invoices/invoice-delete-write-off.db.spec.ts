/**
 * SA-1050 A-1 / R-W2 and G-W4 (real Postgres). `DELETE /invoices/:id` has no status guard (only payments and cash refunds
 * refuse it), so an unpaid written-off invoice deletes today (200). Once the invoice carries a write-off event the FK is
 * RESTRICT: without a readable refusal that delete is a raw P2003 (500). A written-off invoice's history is a past
 * period's bad-debt ledger, so the delete is REFUSED: 409 INVOICE_HAS_WRITE_OFF_HISTORY, nothing deleted (owner question
 * Q6, recommended answer). A legacy written-off invoice with NO event still deletes. G-W4: the customer delete's invoice
 * door (DRAFT invoices only) is unchanged.
 *
 * Events are seeded directly: the writer lands in a later commit of the same PR, and this spec proves the delete doors.
 *
 * Runs only under `npm run local:test:db`; every tenant is a throwaway `qa-wow2-<run>-<n>` slug (`assertTestTenant`).
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

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
/** A fresh, policy-approved throwaway tenant slug — never reused across tests in this file. */
function freshTenantSlug(label: string): string {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-wow2-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "invoice-delete-write-off.db.spec.ts",
  );
}

describeDb("SA-1050 R-W2 / G-W4: invoice delete vs write-off history — real Postgres", () => {
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
    await prisma.creditNote.deleteMany({ where: { tenantId } });
    await prisma.invoiceItem.deleteMany({ where: { tenantId } });
    await prisma.invoice.deleteMany({ where: { tenantId } });
    await prisma.customer.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  }

  async function seedTenant(label: string): Promise<{ id: string; slug: string }> {
    const slug = freshTenantSlug(label);
    const tenant = await prisma.tenant.create({ data: { slug, name: `wow2 ${slug}` } });
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
        businessName: `wow2 customer ${label}`,
        contactName: `wow2 contact ${label}`,
        tenantId,
      },
    });
    return { id: customer.id };
  }

  async function seedInvoice(tenantId: string, customerId: string, label: string) {
    return prisma.invoice.create({
      data: {
        tenantId,
        customerId,
        invoiceNumber: `INV-WOW2-${RUN_SUFFIX}-${label}`,
        status: "SENT",
        subtotal: 50,
        total: 50,
      },
    });
  }

  async function seedWrittenOff(
    tenantId: string,
    customerId: string,
    label: string,
    withEvent: boolean,
  ) {
    const inv = await prisma.invoice.create({
      data: {
        tenantId,
        customerId,
        invoiceNumber: `INV-WOW2-${RUN_SUFFIX}-${label}`,
        status: "WRITTEN_OFF",
        subtotal: 50,
        total: 50,
        writeOffReason: "uncollectable",
        writtenOffAt: new Date(),
      },
    });
    if (withEvent) {
      await prisma.invoiceWriteOffEvent.create({
        data: {
          tenantId,
          invoiceId: inv.id,
          kind: "WRITE_OFF",
          amount: 50,
          preTax: 50,
          at: new Date(),
          reason: "uncollectable",
        },
      });
    }
    return inv;
  }

  it("R-W2: deleteInvoice on an unpaid written-off invoice WITH history: 409 INVOICE_HAS_WRITE_OFF_HISTORY, nothing deleted", async () => {
    const t = await seedTenant("rw2");
    const customer = await seedCustomer(t.id, "rw2");
    const inv = await seedWrittenOff(t.id, customer.id, "rw2", true);

    const err: any = await tenantCtx
      .run(t.id, () => invoicesService.deleteInvoice(inv.id))
      .catch((e: unknown) => e);

    expect(err?.code).not.toBe("P2003"); // head: the RESTRICT FK surfaces raw (500)
    expect(err?.getStatus?.()).toBe(409);
    expect(err.getResponse()).toMatchObject({ code: "INVOICE_HAS_WRITE_OFF_HISTORY" });
    expect(await prisma.invoice.findUnique({ where: { id: inv.id } })).not.toBeNull();
    expect(await prisma.invoiceWriteOffEvent.count({ where: { invoiceId: inv.id } })).toBe(1);
  });

  it("R-W2: after a reinstate the history still stands, so a REINSTATE event also refuses", async () => {
    const t = await seedTenant("rw2r");
    const customer = await seedCustomer(t.id, "rw2r");
    const inv = await seedWrittenOff(t.id, customer.id, "rw2r", true);
    await prisma.invoice.update({ where: { id: inv.id }, data: { status: "SENT" } });
    await prisma.invoiceWriteOffEvent.create({
      data: {
        tenantId: t.id,
        invoiceId: inv.id,
        kind: "REINSTATE",
        amount: -50,
        preTax: -50,
        at: new Date(),
        reason: "paid after all",
      },
    });

    const err: any = await tenantCtx
      .run(t.id, () => invoicesService.deleteInvoice(inv.id))
      .catch((e: unknown) => e);

    expect(err?.getResponse?.()).toMatchObject({ code: "INVOICE_HAS_WRITE_OFF_HISTORY" });
    expect(await prisma.invoice.findUnique({ where: { id: inv.id } })).not.toBeNull();
  });

  it("control: a legacy written-off invoice with NO event still deletes (the head behaviour, 200)", async () => {
    const t = await seedTenant("rw2c");
    const customer = await seedCustomer(t.id, "rw2c");
    const inv = await seedWrittenOff(t.id, customer.id, "rw2c", false);

    await tenantCtx.run(t.id, () => invoicesService.deleteInvoice(inv.id));

    expect(await prisma.invoice.findUnique({ where: { id: inv.id } })).toBeNull();
  });

  it("G-W4: the customer delete's invoice door still deletes a DRAFT invoice (unchanged)", async () => {
    const t = await seedTenant("gw4");
    const customer = await seedCustomer(t.id, "gw4");
    const draft = await prisma.invoice.create({
      data: {
        tenantId: t.id,
        customerId: customer.id,
        invoiceNumber: `INV-WOW2-${RUN_SUFFIX}-gw4`,
        status: "DRAFT",
        subtotal: 10,
        total: 10,
      },
    });

    await deleteNonBlockingInvoicesCas(prisma as any, [customer.id], 1);

    expect(await prisma.invoice.findUnique({ where: { id: draft.id } })).toBeNull();
  });
});
