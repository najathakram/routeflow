/**
 * #2242 (SA-395 5a) — real-Postgres proof that an ISSUED deposit mirror's system NSF fee line
 * survives `reconcileOrderDraftInvoice`'s delete-and-rebuild from the order, with the fee still in
 * the invoice's subtotal and total and outside its tax. Before the fix the rebuild deleted every
 * line and re-summed the order's lines, so the customer's owed NSF fee silently disappeared.
 *
 * Real: PrismaService, InvoicesService, RegulatedLedgerService. Stubbed collaborators are the same
 * set every invoices DB spec stubs (gateway, email, PDF, credit notes, messaging, storage,
 * entitlements off, commission engine), none of which the rebuild's money depends on.
 *
 * Runs only under `npm run local:test:db` (jest.db.config.js). Every tenant is a throwaway
 * `qa-2242-<run>-<n>` slug approved by `assertTestTenant`, deleted in FK order in afterAll.
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

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);

describeDb(
  "an ISSUED deposit mirror keeps its NSF fee line through the order rebuild (#2242)",
  () => {
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
     * A PENDING order (10 × $5 = $50, tax $5) mirrored by ONE issued deposit invoice (SENT,
     * depositPercent 50) that carries the order line plus an NSF fee line of $25 (`systemKind` as
     * given; `null` = a legacy prefix-only line from before #2169's stamp).
     */
    async function seed(label: string, nsfKind: InvoiceItemSystemKind | null) {
      seq += 1;
      const slug = assertTestTenant(
        `qa-2242-${RUN}-${seq}-${label}`,
        "nsf-rebuild-2242.db.spec.ts",
      );
      const tenant = await prisma.tenant.create({ data: { slug, name: `#2242 ${slug}` } });
      tenantIds.push(tenant.id);
      const tenantId = tenant.id;
      const user = await prisma.user.create({
        data: { email: `${slug}@example.invalid`, username: slug, role: "CUSTOMER", tenantId },
      });
      const customer = await prisma.customer.create({
        data: { userId: user.id, businessName: `c ${label}`, contactName: `c ${label}`, tenantId },
      });
      const product = await prisma.product.create({
        data: { tenantId, name: `p ${label}`, unit: "each", pricePerUnit: 5 },
      });
      const order = await prisma.order.create({
        data: {
          tenantId,
          customerId: customer.id,
          status: "PENDING",
          subtotal: 50,
          tax: 5,
          total: 55,
        },
      });
      const li = await prisma.orderItem.create({
        data: {
          tenantId,
          orderId: order.id,
          productId: product.id,
          qty: 10,
          unitPrice: 5,
          subtotal: 50,
        },
      });
      const invoice = await prisma.invoice.create({
        data: {
          tenantId,
          customerId: customer.id,
          orderId: order.id,
          invoiceNumber: `INV-2242-${RUN}-${seq}`,
          status: "SENT",
          depositPercent: 50,
          subtotal: 75,
          taxAmount: 5,
          total: 80,
        },
      });
      await prisma.invoiceItem.create({
        data: {
          tenantId,
          invoiceId: invoice.id,
          orderItemId: li.id,
          productId: product.id,
          description: `p ${label}`,
          qty: 10,
          unitPrice: 5,
          subtotal: 50,
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
      return { tenantId, orderId: order.id, invoiceId: invoice.id, nsfId: nsf.id };
    }

    it.each([
      ["a stamped (systemKind NSF_FEE) line", InvoiceItemSystemKind.NSF_FEE],
      ["a legacy prefix-only (NULL systemKind) line", null],
    ])(
      "%s survives the rebuild; the fee stays in subtotal and total and out of the tax",
      async (_n, kind) => {
        const s = await seed(kind ? "stamped" : "legacy", kind);

        const result: any = await tenantCtx.run(s.tenantId, () =>
          invoices.reconcileOrderDraftInvoice(s.orderId, { basis: "order" }),
        );
        expect(result?.id).toBe(s.invoiceId); // the deposit-mirror path ran

        const nsf = await prisma.invoiceItem.findUnique({ where: { id: s.nsfId } });
        expect(nsf).not.toBeNull(); // the SAME row, not deleted and re-created
        expect(Number(nsf!.subtotal)).toBe(25);
        expect(Number(nsf!.taxRate)).toBe(0);

        const inv = await prisma.invoice.findUnique({
          where: { id: s.invoiceId },
          include: { items: true },
        });
        expect(inv!.items).toHaveLength(2); // one rebuilt order line + the kept NSF line
        expect(Number(inv!.subtotal)).toBe(75); // goods 50 + fee 25
        expect(Number(inv!.taxAmount)).toBe(5); // the order's tax on goods only
        expect(Number(inv!.total)).toBe(80);
      },
    );
  },
);
