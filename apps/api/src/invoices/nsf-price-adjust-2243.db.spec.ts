/**
 * #2243 (SA-395 5b) — real-Postgres proof that `applyPriceAdjustment` on a legacy invoice (every
 * line stored at taxRate 0, a real header tax) stamps B294's inferred rate onto the GOODS lines only:
 * the system NSF fee line keeps taxRate 0 and adds no tax, and the rate is inferred from the goods
 * (regular tax ÷ goods subtotal), not diluted by the untaxed fee in the header subtotal.
 *
 * Real: PrismaService, InvoicesService, RegulatedLedgerService. Stubbed collaborators are the same
 * set every invoices DB spec stubs, none of which the adjustment's money depends on.
 *
 * Runs only under `npm run local:test:db` (jest.db.config.js). Every tenant is a throwaway
 * `qa-2243-<run>-<n>` slug approved by `assertTestTenant`, deleted in FK order in afterAll.
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
import { InvoiceItemSystemKind } from "@prisma/client";
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
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { EstimatesService } from "../estimates/estimates.service";
import { NumberingService } from "../import/numbering.service";
import { NSF_FEE_DESCRIPTION_PREFIX } from "../sales-agents/commission-math";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);

describeDb("a price adjustment never taxes the NSF fee line (#2243)", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let invoices: InvoicesService;
  const tenantIds: string[] = [];
  let seq = 0;

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const mod = await Test.createTestingModule({
      providers: [
        InvoicesService,
        {
          provide: SellingRestrictionsService,
          useValue: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
        },
        EstimatesService,
        NumberingService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: RouteFlowGateway,
          useValue: {
            emitInvoiceUpdated: jest.fn(),
            emitOrderCreated: jest.fn(),
            emitOrderStatusChanged: jest.fn(),
            emitLowStock: jest.fn(),
            emitStopCompleted: jest.fn(),
            emitUrgentOrder: jest.fn(),
          },
        },
        {
          provide: EmailService,
          useValue: {
            sendInvoice: jest.fn(),
            isEmailConfigured: jest.fn().mockResolvedValue(true),
          },
        },
        { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
        {
          provide: SystemConfigService,
          useValue: { get: jest.fn().mockResolvedValue(null), set: jest.fn() },
        },
        RegulatedLedgerService,
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
            settleOrderCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, unapplied: 0 }),
            releaseInvoiceCreditsInTx: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: MessagingService,
          useValue: { notify: jest.fn().mockResolvedValue([]), notifyEvent: jest.fn() },
        },
        {
          provide: StorageService,
          useValue: { upload: jest.fn(), presignedUrl: jest.fn(), delete: jest.fn() },
        },
        {
          provide: EntitlementsService,
          useValue: { hasFlag: jest.fn().mockResolvedValue(false) },
        },
        entitlementAuthorityFromEntitlements, // #2241
        {
          provide: CommissionEngineService,
          useValue: {
            syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined),
            syncOrderInvoices: jest.fn().mockResolvedValue(undefined),
            removeInvoiceCommission: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();
    invoices = mod.get(InvoicesService);
  });

  afterAll(async () => {
    const swallow = () => undefined; // a failed cleanup must never mask a test's result
    for (const tenantId of tenantIds) {
      const where = { where: { tenantId } };
      await prisma.regulatedSalesLedger.deleteMany(where).catch(swallow);
      await prisma.invoicePayment.deleteMany(where).catch(swallow);
      await prisma.invoiceItem.deleteMany(where).catch(swallow);
      await prisma.invoice.deleteMany(where).catch(swallow);
      await prisma.orderItem.deleteMany(where).catch(swallow);
      await prisma.order.deleteMany(where).catch(swallow);
      await prisma.product.deleteMany(where).catch(swallow);
      await prisma.customer.deleteMany(where).catch(swallow);
      await prisma.user.deleteMany(where).catch(swallow);
      await prisma.auditLog.deleteMany(where).catch(swallow);
      await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
    }
    await prisma?.$disconnect();
  });

  /**
   * A SENT legacy invoice: goods $100 (taxRate 0) + an untaxed $25 NSF fee line, header subtotal
   * $125, tax $7.50 (7.5% of the goods), total $132.50. `systemKind` as given; `null` = a legacy
   * prefix-only NSF line from before #2169's stamp.
   */
  async function seed(label: string, nsfKind: InvoiceItemSystemKind | null) {
    seq += 1;
    const slug = assertTestTenant(
      `qa-2243-${RUN}-${seq}-${label}`,
      "nsf-price-adjust-2243.db.spec.ts",
    );
    const tenant = await prisma.tenant.create({ data: { slug, name: `#2243 ${slug}` } });
    tenantIds.push(tenant.id);
    const tenantId = tenant.id;
    const user = await prisma.user.create({
      data: { email: `${slug}@example.invalid`, username: slug, role: "CUSTOMER", tenantId },
    });
    const customer = await prisma.customer.create({
      data: { userId: user.id, businessName: `c ${label}`, contactName: `c ${label}`, tenantId },
    });
    const product = await prisma.product.create({
      data: { tenantId, name: `p ${label}`, unit: "each", pricePerUnit: 100 },
    });
    const invoice = await prisma.invoice.create({
      data: {
        tenantId,
        customerId: customer.id,
        invoiceNumber: `INV-2243-${RUN}-${seq}`,
        status: "SENT",
        subtotal: 125,
        taxAmount: 7.5,
        total: 132.5,
      },
    });
    const goods = await prisma.invoiceItem.create({
      data: {
        tenantId,
        invoiceId: invoice.id,
        productId: product.id,
        description: `p ${label}`,
        qty: 1,
        unitPrice: 100,
        taxRate: 0,
        subtotal: 100,
      },
    });
    const nsf = await prisma.invoiceItem.create({
      data: {
        tenantId,
        invoiceId: invoice.id,
        description: `${NSF_FEE_DESCRIPTION_PREFIX} P-${seq}`,
        qty: 1,
        unitPrice: 25,
        taxRate: 0,
        subtotal: 25,
        systemKind: nsfKind,
      },
    });
    return { tenantId, invoiceId: invoice.id, goodsId: goods.id, nsfId: nsf.id };
  }

  it.each([
    ["a stamped (systemKind NSF_FEE) line", InvoiceItemSystemKind.NSF_FEE],
    ["a legacy prefix-only (NULL systemKind) line", null],
  ])(
    "%s keeps taxRate 0; the goods get the goods-only rate; the header tax is on goods alone",
    async (_n, kind) => {
      const s = await seed(kind ? "stamped" : "legacy", kind);

      await tenantCtx.run(s.tenantId, () =>
        invoices.applyPriceAdjustment(s.invoiceId, {
          items: [{ itemId: s.goodsId, newUnitPrice: 95 }],
          scope: "SINGLE",
        } as any),
      );

      const nsf = await prisma.invoiceItem.findUnique({ where: { id: s.nsfId } });
      expect(Number(nsf!.taxRate)).toBe(0);
      expect(Number(nsf!.subtotal)).toBe(25);
      const goods = await prisma.invoiceItem.findUnique({ where: { id: s.goodsId } });
      expect(Number(goods!.taxRate)).toBe(0.075); // 7.50 / 100, not 7.50 / 125 = 0.06
      const inv = await prisma.invoice.findUnique({ where: { id: s.invoiceId } });
      expect(Number(inv!.subtotal)).toBe(120); // goods 95 + fee 25
      expect(Number(inv!.taxAmount)).toBe(7.13); // 95 × 7.5% = 7.125 → 7.13; the fee adds 0
      expect(Number(inv!.total)).toBe(127.13);
    },
  );
});
