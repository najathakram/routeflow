/**
 * B214 (train 4 Run A) — DB-lane repro: `deleteInvoice` must refuse (409
 * INVOICE_HAS_UNSPENT_CREDIT) while a credit note it sourced still has an unspent balance,
 * instead of unlinking it (`invoiceId: null`) and deleting the invoice out from under it.
 * Design of record: `.claude/pipeline/2026-09-10-train4-run-a/cause-ruling.md`;
 * test plan: `.claude/pipeline/2026-09-10-train4-run-a/bug-test-plan.md` (T9, T10, P5-P7).
 *
 * WHY THE DB LANE: the FK's `ON DELETE SET NULL` behavior (`0_init/migration.sql:3783`) and
 * whether a rolled-back transaction actually leaves the credit note linked are only provable
 * against a REAL Postgres — a mocked `tx.invoice.delete` can't reproduce either. Collected only
 * by `jest.db.config.js` (`.db.spec.ts$`), run via `npm run local:test:db`
 * (`node scripts/local-env.mjs --db --db-specs -- "npm run test:db -w apps/api"`), which points
 * DATABASE_URL at the compose Postgres and sets RUN_DB_SPECS. `requireLocalDatabaseUrl()`
 * refuses any non-local host.
 *
 * This spec drives the REAL `InvoicesService.deleteInvoice()` through a NestJS TestingModule
 * wired with a REAL `PrismaService` (bound to the compose DB) and a REAL `TenantContextService`,
 * with every OTHER collaborator mocked at the module boundary exactly as
 * `invoice-numbering.db.spec.ts` does (same jest.mock shims for `InvoicePdfService` /
 * `compressDocument` — ESM traversal guard).
 *
 * SAFETY: every tenant this file creates is a throwaway `qa-b214-<run>-<n>-<label>` slug,
 * approved by `assertTestTenant` (`scripts/lib/test-tenants.cjs`); `afterAll` deletes exactly the
 * tenants THIS run created, in FK order (CreditNote → InvoiceItem → Invoice → Customer → User →
 * Tenant), best-effort, never anyone else's rows.
 *
 * SELF-CONTAINED ORACLES: T9 and T10 each seed their own tenant/invoice/credit-note trio, so
 * neither test's expectation depends on a sibling having run first.
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
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { EstimatesService } from "../estimates/estimates.service";
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
    `qa-b214-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "invoice-delete-credit.db.spec.ts",
  );
}

describeDb("B214 invoice delete vs sourced credit notes — real Postgres", () => {
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
        EstimatesService,
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
        // Best-effort: a failed cleanup must never mask a test's own pass/fail result.
      });
    }
    await prisma?.$disconnect();
  });

  async function cleanupTenant(tenantId: string): Promise<void> {
    await prisma.creditNote.deleteMany({ where: { tenantId } });
    await prisma.invoiceItem.deleteMany({ where: { tenantId } });
    await prisma.invoice.deleteMany({ where: { tenantId } });
    await prisma.customer.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  }

  async function seedTenant(label: string): Promise<{ id: string; slug: string }> {
    const slug = freshTenantSlug(label);
    const tenant = await prisma.tenant.create({ data: { slug, name: `B214 ${slug}` } });
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
        businessName: `B214 customer ${label}`,
        contactName: `B214 contact ${label}`,
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
        invoiceNumber: `INV-B214-${RUN_SUFFIX}-${label}`,
        status: "SENT",
        subtotal: 50,
        total: 50,
      },
    });
  }

  async function seedCreditNote(
    tenantId: string,
    customerId: string,
    invoiceId: string,
    label: string,
    opts: { amountUsed: number; status: "ISSUED" | "APPLIED" | "VOID"; expiresAt: Date | null },
  ) {
    return prisma.creditNote.create({
      data: {
        tenantId,
        customerId,
        invoiceId,
        creditNoteNumber: `CN-B214-${RUN_SUFFIX}-${label}`,
        amount: 50,
        amountUsed: opts.amountUsed,
        status: opts.status,
        expiresAt: opts.expiresAt,
      },
    });
  }

  // T9 — REG-B214: deleteInvoice refuses (409) while a credit note it sourced has unspent
  // balance (real Postgres).
  it("REG-B214 (T9): deleteInvoice refuses (409) while a credit note it sourced has unspent balance (real Postgres)", async () => {
    const t = await seedTenant("t9");
    const customer = await seedCustomer(t.id, "t9");
    const inv = await seedInvoice(t.id, customer.id, "t9");
    await seedCreditNote(t.id, customer.id, inv.id, "t9", {
      amountUsed: 0,
      status: "ISSUED",
      expiresAt: null,
    });

    await expect(
      tenantCtx.run(t.id, () => invoicesService.deleteInvoice(inv.id)),
    ).rejects.toMatchObject({ response: { code: "INVOICE_HAS_UNSPENT_CREDIT" } });
  });

  // T10 — REG-B214: after the refused delete, the credit note is still linked to its invoice
  // (the rolled-back tx must not leave a partial unlink committed).
  it("REG-B214 (T10): after the refused delete, the credit note is still linked to its invoice", async () => {
    const t = await seedTenant("t10");
    const customer = await seedCustomer(t.id, "t10");
    const inv = await seedInvoice(t.id, customer.id, "t10");
    const cn = await seedCreditNote(t.id, customer.id, inv.id, "t10", {
      amountUsed: 0,
      status: "ISSUED",
      expiresAt: null,
    });

    await tenantCtx.run(t.id, () => invoicesService.deleteInvoice(inv.id)).catch((e) => e);

    const noteAfter = await prisma.creditNote.findUnique({ where: { id: cn.id } });
    expect(noteAfter?.invoiceId).toBe(inv.id);
  });

  // P5 — pin: a fully spent sourced note does not block the delete, and is unlinked as today.
  it("deleteInvoice with a fully spent sourced note (P5) resolves and unlinks the note", async () => {
    const t = await seedTenant("p5");
    const customer = await seedCustomer(t.id, "p5");
    const inv = await seedInvoice(t.id, customer.id, "p5");
    const cn = await seedCreditNote(t.id, customer.id, inv.id, "p5", {
      amountUsed: 50,
      status: "APPLIED",
      expiresAt: null,
    });

    const result = await tenantCtx.run(t.id, () => invoicesService.deleteInvoice(inv.id));
    expect(result).toMatchObject({ id: inv.id, message: "Invoice deleted successfully" });

    const noteAfter = await prisma.creditNote.findUnique({ where: { id: cn.id } });
    expect(noteAfter?.invoiceId).toBeNull();
  });

  // P6 — pin: an expired unspent sourced note does not block the delete.
  it("deleteInvoice with an expired unspent sourced note (P6) resolves", async () => {
    const t = await seedTenant("p6");
    const customer = await seedCustomer(t.id, "p6");
    const inv = await seedInvoice(t.id, customer.id, "p6");
    await seedCreditNote(t.id, customer.id, inv.id, "p6", {
      amountUsed: 0,
      status: "ISSUED",
      expiresAt: new Date(Date.now() - 86_400_000),
    });

    const result = await tenantCtx.run(t.id, () => invoicesService.deleteInvoice(inv.id));
    expect(result).toMatchObject({ id: inv.id, message: "Invoice deleted successfully" });
  });

  // P7 — pin: a VOID sourced note does not block the delete.
  it("deleteInvoice with a VOID sourced note (P7) resolves", async () => {
    const t = await seedTenant("p7");
    const customer = await seedCustomer(t.id, "p7");
    const inv = await seedInvoice(t.id, customer.id, "p7");
    await seedCreditNote(t.id, customer.id, inv.id, "p7", {
      amountUsed: 0,
      status: "VOID",
      expiresAt: null,
    });

    const result = await tenantCtx.run(t.id, () => invoicesService.deleteInvoice(inv.id));
    expect(result).toMatchObject({ id: inv.id, message: "Invoice deleted successfully" });
  });
});
