/**
 * B1461 (Ops W-1449), real Postgres: a staff order edit's PRICE change follows onto the order's DRAFT partial
 * (SA-760 Q-760-1, `applyPartialPriceFollow`), and the regulated sales ledger must follow with it. A DRAFT
 * partial books SALE rows at creation (`createPartialFromOrder` -> `resyncInvoiceLedger`, SA-962 row 721), so
 * once its line net moves, the ledger rows that the tax filing sums must move too.
 *
 * The flow is the production one end to end: two partials are cut by `createPartialFromOrder` (A then B, 4 of
 * 10 each); A is issued (SENT), B stays DRAFT; the order line is re-priced $10 -> $12 the way the order edit's
 * fold writes it; then the order-edit tail `syncInvoicesAfterEdit` runs as a staff edit (pre-delivery: the
 * reconcile returns RECONCILE_PARTIALS, so the partials follow).
 *   - harness: B's line follows to $48 and A's stays at $40 (the follow itself works on master).
 *   - REG-B1461: B's ledger nets $48 for the line. Master: $40, the old price (the follow never calls the ledger).
 *   - pin: issued A's ledger stays at $40 (an issued partial never changes).
 *
 * Real: PrismaService, InvoicesService, RegulatedLedgerService. Stubbed collaborators are the set every
 * invoices DB spec stubs, none of which the ledger's money depends on.
 *
 * Runs only under `npm run local:test:db` (jest.db.config.js). Every tenant is a throwaway
 * `qa-b1461-<run>-<n>` slug approved by `assertTestTenant`, deleted in FK order in afterAll.
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
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { EstimatesService } from "../estimates/estimates.service";
import { NumberingService } from "../import/numbering.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { syncInvoicesAfterEdit } from "../orders/order-edit-invoice-sync";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);

describeDb(
  "B1461 — a DRAFT partial's price follow moves its regulated ledger rows, real Postgres",
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
            useValue: {
              get: jest.fn().mockResolvedValue(null),
              getAll: jest.fn().mockResolvedValue({}),
              set: jest.fn(),
            },
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
          entitlementAuthorityFromEntitlements,
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
        await prisma.trackedCategory.deleteMany(where).catch(swallow);
        await prisma.customer.deleteMany(where).catch(swallow);
        await prisma.user.deleteMany(where).catch(swallow);
        await prisma.auditLog.deleteMany(where).catch(swallow);
        await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
      }
      await prisma?.$disconnect();
    });

    /**
     * A CONFIRMED order with one regulated line (10 x $10, a $0.05/unit excise), cut into two partials by the
     * production writer: A (4 of 10, then issued SENT) and B (4 of 10, left DRAFT). Each partial's creation books
     * its own SALE rows ($40 each).
     */
    async function seed(label: string) {
      seq += 1;
      const slug = assertTestTenant(
        `qa-b1461-${RUN}-${seq}-${label}`,
        "partial-price-follow-ledger-b1461.db.spec.ts",
      );
      const tenant = await prisma.tenant.create({ data: { slug, name: `B1461 ${slug}` } });
      tenantIds.push(tenant.id);
      const tenantId = tenant.id;
      const user = await prisma.user.create({
        data: { email: `${slug}@example.invalid`, username: slug, role: "CUSTOMER", tenantId },
      });
      const customer = await prisma.customer.create({
        data: {
          userId: user.id,
          businessName: `acme ${label}`,
          contactName: `acme ${label}`,
          tenantId,
        },
      });
      const category = await prisma.trackedCategory.create({
        data: { tenantId, name: `cat ${label}`, taxType: "EXCISE_PER_UNIT", rate: 0.05 },
      });
      const product = await prisma.product.create({
        data: {
          tenantId,
          name: `acme item ${label}`,
          unit: "each",
          pricePerUnit: 10,
          trackedCategoryId: category.id,
        },
      });
      const order = await prisma.order.create({
        data: {
          tenantId,
          customerId: customer.id,
          orderNumber: `ORD-B1461-${RUN}-${seq}`,
          status: "CONFIRMED",
          subtotal: 100,
          tax: 0,
          total: 100.5,
        },
      });
      const line = await prisma.orderItem.create({
        data: {
          tenantId,
          orderId: order.id,
          productId: product.id,
          qty: 10,
          unitPrice: 10,
          subtotal: 100,
          status: "CONFIRMED",
          trackedCategoryId: category.id,
          categoryTaxAmount: 0.5,
          categoryTaxType: "EXCISE_PER_UNIT",
          categoryTaxRate: 0.05,
          categoryPriceIncludesTax: false,
        },
      });
      const cut = () =>
        tenantCtx.run(tenantId, () =>
          invoices.createPartialFromOrder(order.id, { items: [{ orderItemId: line.id, qty: 4 }] }),
        );
      const a = await cut();
      await prisma.invoice.update({ where: { id: a.id }, data: { status: "SENT" } }); // A is issued
      const b = await cut(); // B stays DRAFT
      return {
        tenantId,
        orderId: order.id,
        lineId: line.id,
        aId: a.id as string,
        bId: b.id as string,
      };
    }
    type Seeded = Awaited<ReturnType<typeof seed>>;

    /** The order edit's fold re-prices the line ($10 -> $12); then the production edit tail runs as staff. */
    async function repriceAndSync(s: Seeded) {
      await prisma.orderItem.update({
        where: { id: s.lineId },
        data: { unitPrice: 12, subtotal: 120 },
      });
      await prisma.order.update({
        where: { id: s.orderId },
        data: { subtotal: 120, total: 120.5 },
      });
      return tenantCtx.run(s.tenantId, () =>
        syncInvoicesAfterEdit(
          invoices,
          s.orderId,
          { postDeliveryEdit: false, skipInPlaceResync: false },
          null,
          true, // a staff edit: DRAFT partials follow the price
        ),
      );
    }

    /** Σ of the invoice's signed ledger rows: what the filing reports for it. */
    async function ledgerNet(invoiceId: string) {
      const rows = await prisma.regulatedSalesLedger.findMany({ where: { invoiceId } });
      const sum = (k: "qty" | "netSales" | "categoryTax") =>
        Math.round(rows.reduce((t, r) => t + Number(r[k]), 0) * 1000) / 1000;
      return { qty: sum("qty"), netSales: sum("netSales"), categoryTax: sum("categoryTax") };
    }
    const lineSubtotal = async (invoiceId: string) =>
      Number((await prisma.invoiceItem.findFirstOrThrow({ where: { invoiceId } })).subtotal);

    it("harness: each partial's creation booked its SALE rows at $40, and the follow re-prices DRAFT B only", async () => {
      const s = await seed("harness");
      expect(await ledgerNet(s.aId)).toEqual({ qty: 4, netSales: 40, categoryTax: 0.2 });
      expect(await ledgerNet(s.bId)).toEqual({ qty: 4, netSales: 40, categoryTax: 0.2 });
      const unchanged = await repriceAndSync(s);
      expect(unchanged.map((u) => u.invoiceId)).toEqual([s.aId]); // issued A is listed, never changed
      expect(await lineSubtotal(s.bId)).toBe(48); // the DRAFT partial followed the price
      expect(await lineSubtotal(s.aId)).toBe(40);
    }, 120_000);

    it("REG-B1461: after the follow, DRAFT B's ledger nets the new $48, not the old $40", async () => {
      const s = await seed("reg");
      await repriceAndSync(s);
      // master: { qty: 4, netSales: 40, categoryTax: 0.2 } -- the follow re-priced the line and never synced the ledger
      expect(await ledgerNet(s.bId)).toEqual({ qty: 4, netSales: 48, categoryTax: 0.2 });
    }, 120_000);

    it("pin: issued A's ledger stays at $40 (an issued partial never follows)", async () => {
      const s = await seed("issued");
      await repriceAndSync(s);
      expect(await ledgerNet(s.aId)).toEqual({ qty: 4, netSales: 40, categoryTax: 0.2 });
    }, 120_000);
  },
);
