/**
 * #2197 / #2249 — DB-lane proof (F2 prover, SA-405): `InvoicesService.create()` / `update()` store
 * the LITERAL calendar day a client issueDate names, against a REAL Postgres, for a tenant whose
 * zone is America/New_York. An offset different from the tenant zone, an instant at exactly UTC
 * midnight of the next day, and a bare date all store the 25th; an impossible date is a 400 that
 * writes nothing; `update()` WITH items keeps (or re-stamps) the literal day.
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`), run via `npm run local:test:db`, which
 * points DATABASE_URL at the compose Postgres and sets RUN_DB_SPECS; `requireLocalDatabaseUrl()`
 * refuses any non-local host. The REAL service runs with a REAL `PrismaService` and
 * `TenantContextService`; every other collaborator is mocked at the module boundary, as
 * `invoice-numbering.db.spec.ts` does.
 *
 * SAFETY: the one tenant this file creates is a throwaway `qa-f2-2249-<run>-<n>-ny` slug approved
 * by `assertTestTenant` (`scripts/lib/test-tenants.cjs`), with its own TenantConfig, user and
 * customer, so it needs no seed. `afterAll` deletes exactly that tenant's rows, best-effort.
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
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
/** A fresh, policy-approved throwaway tenant slug — never reused across tests in this file. */
function freshTenantSlug(label: string): string {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-f2-2249-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "invoice-issue-date-b2197.db.spec.ts",
  );
}

describeDb(
  "B2197 (#2249) issueDate stores the literal calendar day — NY-zone tenant, real Postgres",
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
          {
            provide: RegulatedLedgerService,
            useValue: {
              writeSaleEntries: jest.fn(),
              reverseInvoiceEntries: jest.fn(),
              syncInvoiceEntries: jest.fn(),
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

    // ─── F2 throwaway (#2249 / B2197) ───
    async function cleanupTenant(tenantId: string): Promise<void> {
      await prisma.invoiceItem.deleteMany({ where: { tenantId } });
      await prisma.invoice.deleteMany({ where: { tenantId } });
      await prisma.customer.deleteMany({ where: { tenantId } });
      await prisma.user.deleteMany({ where: { tenantId } });
      await (prisma as any).tenantConfig.deleteMany({ where: { tenantId } });
      await prisma.tenant.delete({ where: { id: tenantId } });
    }
    let ctx: { tenantId: string; customerId: string };
    beforeAll(async () => {
      const slug = freshTenantSlug("ny");
      const tenant = await prisma.tenant.create({ data: { slug, name: `F2 2249 ${slug}` } });
      createdTenantIds.push(tenant.id);
      await (prisma as any).tenantConfig.create({
        data: { tenantId: tenant.id, timezone: "America/New_York" },
      });
      const idBase = `${tenant.id}-ny`;
      const user = await prisma.user.create({
        data: {
          email: `${idBase}@example.invalid`,
          username: idBase,
          role: "CUSTOMER",
          tenantId: tenant.id,
        },
      });
      const customer = await prisma.customer.create({
        data: { userId: user.id, businessName: "F2 NY", contactName: "F2", tenantId: tenant.id },
      });
      ctx = { tenantId: tenant.id, customerId: customer.id };
    });
    const create = (issueDate: string) =>
      tenantCtx.run(ctx.tenantId, () =>
        invoicesService.create({
          customerId: ctx.customerId,
          issueDate,
          items: [{ description: "f2 line", qty: 1, unitPrice: 10 }],
        } as any),
      ) as Promise<any>;
    const storedIso = async (id: string) =>
      (await prisma.invoice.findUniqueOrThrow({ where: { id } })).issueDate!.toISOString();

    it("create: '2026-09-25T23:30:00-05:00' stores the 25th (2026-09-25T00:00:00.000Z)", async () => {
      const inv = await create("2026-09-25T23:30:00-05:00");
      expect(await storedIso(inv.id)).toBe("2026-09-25T00:00:00.000Z");
    });
    it("create: '2026-09-25T20:00:00-04:00' stores the 25th", async () => {
      const inv = await create("2026-09-25T20:00:00-04:00");
      expect(await storedIso(inv.id)).toBe("2026-09-25T00:00:00.000Z");
    });
    it("create: a bare '2026-09-25' stores as-is", async () => {
      const inv = await create("2026-09-25");
      expect(await storedIso(inv.id)).toBe("2026-09-25T00:00:00.000Z");
    });
    it("create: '2026-02-31' is a 400 and NOTHING is written", async () => {
      const before = await prisma.invoice.count({ where: { tenantId: ctx.tenantId } });
      await expect(create("2026-02-31")).rejects.toMatchObject({ status: 400 });
      expect(await prisma.invoice.count({ where: { tenantId: ctx.tenantId } })).toBe(before);
    });
    it("update: both offset strings store the 25th; '2026-02-31' is a 400 leaving the day untouched", async () => {
      const inv = await create("2026-09-01");
      for (const raw of ["2026-09-25T23:30:00-05:00", "2026-09-25T20:00:00-04:00"]) {
        await tenantCtx.run(ctx.tenantId, () =>
          invoicesService.update(inv.id, { issueDate: "2026-09-10" } as any),
        );
        await tenantCtx.run(ctx.tenantId, () =>
          invoicesService.update(inv.id, { issueDate: raw } as any),
        );
        expect(await storedIso(inv.id)).toBe("2026-09-25T00:00:00.000Z");
      }
      await expect(
        tenantCtx.run(ctx.tenantId, () =>
          invoicesService.update(inv.id, { issueDate: "2026-02-31" } as any),
        ),
      ).rejects.toMatchObject({ status: 400 });
      expect(await storedIso(inv.id)).toBe("2026-09-25T00:00:00.000Z");
    });
    it("update WITH items (no issueDate) keeps the day; WITH items + an offset issueDate stores the 25th", async () => {
      const inv = await create("2026-09-25T23:30:00-05:00");
      const [line] = await prisma.invoiceItem.findMany({ where: { invoiceId: inv.id } });
      await tenantCtx.run(ctx.tenantId, () =>
        invoicesService.update(inv.id, {
          items: [{ id: line.id, description: "f2 line edited", qty: 2, unitPrice: 10 }],
        } as any),
      );
      expect(await storedIso(inv.id)).toBe("2026-09-25T00:00:00.000Z");
      await tenantCtx.run(ctx.tenantId, () =>
        invoicesService.update(inv.id, {
          issueDate: "2026-09-25T20:00:00-04:00",
          items: [{ id: line.id, description: "f2 line edited 2", qty: 3, unitPrice: 10 }],
        } as any),
      );
      expect(await storedIso(inv.id)).toBe("2026-09-25T00:00:00.000Z");
      expect(
        Number((await prisma.invoiceItem.findFirstOrThrow({ where: { invoiceId: inv.id } })).qty),
      ).toBe(3);
    });
  },
);
