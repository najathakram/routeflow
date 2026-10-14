/**
 * F-05 (#2093/#2101) — real-Postgres pin for the selling-restrictions ban on the two paths that SELL:
 * `EstimatesService.convertToInvoice` and `InvoicesService.create`. Drives the REAL services with the
 * REAL `SellingRestrictionsService` + `ProductLabelsService` over a REAL rule (a STATE ban on a
 * category) and a REAL customer address. Proves, per path: tenant flag ON + customer in the banned
 * state + product in the banned category is refused (409 SELLING_RESTRICTED) with NOTHING written;
 * the same sale is allowed when the flag is OFF or absent, and when the customer is in another state.
 * Collected only by `jest.db.config.js`; run via `npm run local:test:db`. Every tenant is a throwaway
 * `qa-f2ban-*` slug approved by `assertTestTenant`; afterAll deletes exactly what it made.
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
import { ProductLabelsService } from "../product-labels/product-labels.service";
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
    `qa-f2ban-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "invoices.sell-ban.db.spec.ts",
  );
}

describeDb("F05 ban check on estimate convert + invoice create — real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let invoicesService: InvoicesService;
  let estimatesService: EstimatesService;
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
        SellingRestrictionsService,
        ProductLabelsService,
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
        entitlementAuthorityFromEntitlements, // #2241
        { provide: CommissionEngineService, useValue: mockCommissionEngine },
      ],
    }).compile();

    invoicesService = module.get(InvoicesService);
    estimatesService = module.get(EstimatesService);
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
    await prisma.sellingRestriction.deleteMany({ where: { tenantId } });
    await prisma.productCategoryLabel.deleteMany({ where: { tenantId } });
    await prisma.systemConfig.deleteMany({ where: { tenantId } });
    await prisma.auditLog.deleteMany({ where: { tenantId } });
    await prisma.estimate.deleteMany({ where: { tenantId } });
    await prisma.invoiceItem.deleteMany({ where: { tenantId } });
    await prisma.invoice.deleteMany({ where: { tenantId } });
    await prisma.numberingSequence.deleteMany({ where: { tenantId } });
    await prisma.customerAddress.deleteMany({ where: { tenantId } });
    await prisma.customer.deleteMany({ where: { tenantId } });
    await prisma.product.deleteMany({ where: { tenantId } });
    await prisma.productCategory.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  }

  /** flag: "on" writes selling_restrictions.enabled=true, "off" writes "false", "absent" writes no row. */
  async function seed(label: string, flag: "on" | "off" | "absent", state: string) {
    const slug = freshTenantSlug(label);
    const tenant = await prisma.tenant.create({ data: { slug, name: `F05 ${slug}` } });
    createdTenantIds.push(tenant.id);
    const tenantId = tenant.id;
    const idBase = `${tenantId}-c`;
    const user = await prisma.user.create({
      data: { email: `${idBase}@example.invalid`, username: idBase, role: "CUSTOMER", tenantId },
    });
    const customer = await prisma.customer.create({
      data: { userId: user.id, businessName: "F05 customer", contactName: "F05", tenantId },
    });
    await prisma.customerAddress.create({
      data: {
        tenantId,
        customerId: customer.id,
        line1: "1 Test St",
        city: "Testville",
        state,
        stateCode: state,
        zip: "00000",
        isDefault: true,
        addressType: "BILLING",
      },
    });
    const category = await prisma.productCategory.create({
      data: { tenantId, name: "Banned goods" },
    });
    const banned = await prisma.product.create({
      data: { tenantId, name: "F05 banned", unit: "each", pricePerUnit: 10 },
    });
    await prisma.productCategoryLabel.create({
      data: { tenantId, productId: banned.id, categoryId: category.id, mode: "INCLUDE" },
    });
    await prisma.sellingRestriction.create({
      data: {
        tenantId,
        categoryId: category.id,
        jurisdiction: "STATE",
        states: ["CA"],
        reason: "F05 pin",
        effectiveFrom: new Date("2026-01-01T00:00:00Z"),
      },
    });
    if (flag !== "absent") {
      await prisma.systemConfig.create({
        data: {
          tenantId,
          key: "selling_restrictions.enabled",
          value: flag === "on" ? "true" : "false",
        },
      });
    }
    const estimate = await prisma.estimate.create({
      data: {
        tenantId,
        customerId: customer.id,
        estimateNumber: `EST-F2B-${RUN_SUFFIX}-${label}`,
        status: "ACCEPTED",
        subtotal: 10,
        total: 10,
        items: {
          create: [
            {
              tenantId,
              description: "banned line",
              productId: banned.id,
              qty: 1,
              unitPrice: 10,
              subtotal: 10,
            },
          ],
        },
      },
    });
    return { tenantId, customerId: customer.id, productId: banned.id, estimateId: estimate.id };
  }

  const convert = (s: { tenantId: string; estimateId: string }) =>
    tenantCtx.run(s.tenantId, () => estimatesService.convertToInvoice(s.estimateId));
  const createInvoice = (s: { tenantId: string; customerId: string; productId: string }) =>
    tenantCtx.run(s.tenantId, () =>
      invoicesService.create({
        customerId: s.customerId,
        items: [{ description: "banned line", productId: s.productId, qty: 1, unitPrice: 10 }],
      } as any),
    );
  const nothingWritten = async (s: { tenantId: string; estimateId: string }) => {
    expect(await prisma.invoice.count({ where: { tenantId: s.tenantId } })).toBe(0);
    expect(await prisma.invoiceItem.count({ where: { tenantId: s.tenantId } })).toBe(0);
    const est = await prisma.estimate.findUnique({ where: { id: s.estimateId } });
    expect(est!.status).toBe("ACCEPTED");
    expect(est!.invoiceId).toBeNull();
    // the refusal comes BEFORE a number is reserved: no INVOICE sequence row was minted
    expect(await prisma.numberingSequence.count({ where: { tenantId: s.tenantId } })).toBe(0);
  };

  it("flag ON + CA customer + banned category: estimate convert is refused 409 SELLING_RESTRICTED, nothing written", async () => {
    const s = await seed("on-conv", "on", "CA");
    await expect(convert(s)).rejects.toMatchObject({ response: { code: "SELLING_RESTRICTED" } });
    await nothingWritten(s);
  });

  it("flag ON + CA customer + banned category: invoice create is refused 409 SELLING_RESTRICTED, nothing written", async () => {
    const s = await seed("on-create", "on", "CA");
    await expect(createInvoice(s)).rejects.toMatchObject({
      response: { code: "SELLING_RESTRICTED" },
    });
    await nothingWritten(s);
  });

  it("flag ON but customer in a state the rule does not name (NY): both paths are ALLOWED", async () => {
    const s = await seed("on-ny", "on", "NY");
    const inv = await createInvoice(s);
    expect((inv as any).id).toBeDefined();
    const conv = await convert(s);
    expect((conv as any).id).toBeDefined();
    expect((await prisma.estimate.findUnique({ where: { id: s.estimateId } }))!.status).toBe(
      "CONVERTED",
    );
  });

  it("row 510: a leftover switch row set to 'false' changes nothing: both paths are refused (no actor, so no override)", async () => {
    const s = await seed("off", "off", "CA");
    await expect(createInvoice(s)).rejects.toMatchObject({
      response: { code: "SELLING_RESTRICTED" },
    });
    await expect(convert(s)).rejects.toMatchObject({ response: { code: "SELLING_RESTRICTED" } });
    await nothingWritten(s);
  });

  it("row 510: no switch row at all changes nothing either (the switch is gone): both paths are refused", async () => {
    const s = await seed("absent", "absent", "CA");
    await expect(createInvoice(s)).rejects.toMatchObject({
      response: { code: "SELLING_RESTRICTED" },
    });
    await expect(convert(s)).rejects.toMatchObject({ response: { code: "SELLING_RESTRICTED" } });
    await nothingWritten(s);
  });
});
