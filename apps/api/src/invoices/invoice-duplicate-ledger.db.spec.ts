/**
 * B680 — DB-lane proof that `InvoicesService.duplicate()` writes its OWN regulated-ledger SALE
 * rows for a regulated invoice copy (same path as create()). The REAL RegulatedLedgerService is
 * provided below (its one dependency, PrismaService, is real too) so the rows are read back from
 * Postgres — a jest.fn() ledger here would write nothing and every row assertion would fail.
 * Collected only by `jest.db.config.js`; every tenant is a throwaway
 * `qa-b680-<run>-<n>-<label>` slug approved by `assertTestTenant`, deleted in FK order in
 * `afterAll`.
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
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { NumberingService } from "../import/numbering.service";
import { periodBucketOf } from "../regulated/period";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
const SOURCE_ISSUE_DATE = new Date("2020-01-15T00:00:00.000Z");
/** A fresh, policy-approved throwaway tenant slug — never reused across tests in this file. */
function freshTenantSlug(label: string): string {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-b680-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "invoice-duplicate-ledger.db.spec.ts",
  );
}

describeDb(
  "duplicate() writes the copy's own regulated-ledger SALE rows — real Postgres (B680/SA-374)",
  () => {
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
          RegulatedLedgerService, // the REAL service: SALE rows are read back from Postgres
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
          entitlementAuthorityFromEntitlements, // #2241
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
      await prisma.returnItem.deleteMany({ where: { tenantId } });
      await prisma.return.deleteMany({ where: { tenantId } });
      await prisma.regulatedSalesLedger.deleteMany({ where: { tenantId } });
      await prisma.creditNote.deleteMany({ where: { tenantId } });
      await prisma.auditLog.deleteMany({ where: { tenantId } });
      await prisma.invoiceItem.deleteMany({ where: { tenantId } });
      await prisma.invoice.deleteMany({ where: { tenantId } });
      await prisma.order.deleteMany({ where: { tenantId } });
      await prisma.customer.deleteMany({ where: { tenantId } });
      await prisma.product.deleteMany({ where: { tenantId } });
      await prisma.trackedCategory.deleteMany({ where: { tenantId } });
      await prisma.user.deleteMany({ where: { tenantId } });
      await prisma.tenant.delete({ where: { id: tenantId } });
    }

    async function seedTenant(label: string): Promise<{ id: string; slug: string }> {
      const slug = freshTenantSlug(label);
      const tenant = await prisma.tenant.create({
        data: { slug, name: `b680 ${slug}` },
      });
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
          businessName: `customer ${label}`,
          contactName: `contact ${label}`,
          tenantId,
        },
      });
      return { id: customer.id };
    }

    async function seedRegulatedInvoice(label: string) {
      const t = await seedTenant(label);
      const customer = await seedCustomer(t.id, label);
      const cat = await prisma.trackedCategory.create({
        data: { tenantId: t.id, name: `cat ${label}`, taxType: "EXCISE_PER_UNIT", rate: 0.1 },
      });
      const product = await prisma.product.create({
        data: {
          tenantId: t.id,
          name: `b680 boxed ${label}`,
          unit: "each",
          pricePerUnit: 40,
          unitsPerBox: 12,
          trackedCategoryId: cat.id,
        },
      });
      const inv = await prisma.invoice.create({
        data: {
          tenantId: t.id,
          customerId: customer.id,
          invoiceNumber: `INV-B680-${RUN_SUFFIX}-${label}`,
          status: "DRAFT",
          // An old source date: the copy's SALE row must book today, never this.
          issueDate: SOURCE_ISSUE_DATE,
          subtotal: 240,
          taxAmount: 7.2,
          total: 247.2,
        },
      });
      await prisma.invoiceItem.create({
        data: {
          tenantId: t.id,
          invoiceId: inv.id,
          productId: product.id,
          description: "regulated boxed",
          qty: 72,
          boxes: 6,
          pieces: 0,
          unitsPerBox: 12,
          unitPrice: 40,
          subtotal: 240,
          trackedCategoryId: cat.id,
          categoryTaxAmount: 7.2,
        },
      });
      return { t, inv, cat };
    }
    const run = (s: any, id: string) => tenantCtx.run(s.t.id, () => invoicesService.duplicate(id));

    it("B680-A duplicating a regulated invoice writes SALE rows keyed to the COPY's own invoice and item ids", async () => {
      const s = await seedRegulatedInvoice("a");
      const copy: any = await run(s, s.inv.id);
      const rows = await prisma.regulatedSalesLedger.findMany({ where: { tenantId: s.t.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        invoiceId: copy.id,
        invoiceItemId: copy.items[0].id,
        trackedCategoryId: s.cat.id,
        entryType: "SALE",
      });
      expect(Number(rows[0].qty)).toBe(72);
      // B661 invariant: 6 boxes x the snapshot pack of 12 = 72 pieces on the unit basis.
      expect(Number(rows[0].unitBasisQty)).toBe(72);
      // Books in the copy's own period (today), never the source's issueDate.
      // (The copy's issueDate is the tenant's calendar day, so compare against it rather than
      // periodBucketOf(new Date()), which could flake across a month boundary.)
      const copyIssue = new Date(copy.issueDate);
      expect(Math.abs(Date.now() - copyIssue.getTime())).toBeLessThan(36 * 60 * 60 * 1000);
      expect(rows[0].soldAt.getTime()).toBe(copyIssue.getTime());
      expect(rows[0].periodBucket).toBe(periodBucketOf(copyIssue));
      expect(rows[0].periodBucket).not.toBe(periodBucketOf(SOURCE_ISSUE_DATE));
      expect(rows[0].invoiceId).not.toBe(s.inv.id);
    });

    it("B680-B the copy's SALE row books the same levy figures a create() would (one row, not two)", async () => {
      const s = await seedRegulatedInvoice("b");
      await run(s, s.inv.id);
      const rows = await prisma.regulatedSalesLedger.findMany({ where: { tenantId: s.t.id } });
      expect(rows.map((r) => Number(r.categoryTax))).toEqual([7.2]);
    });

    it("B680-C a non-regulated invoice's copy writes no ledger rows", async () => {
      const s = await seedRegulatedInvoice("c");
      await prisma.invoiceItem.updateMany({
        where: { invoiceId: s.inv.id },
        data: { trackedCategoryId: null, categoryTaxAmount: 0 },
      });
      await run(s, s.inv.id);
      expect(await prisma.regulatedSalesLedger.count({ where: { tenantId: s.t.id } })).toBe(0);
    });
  },
);
