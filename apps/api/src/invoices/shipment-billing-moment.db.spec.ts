/**
 * SA-667(e) / SA-674(b) - real-Postgres pin of the shipment billing moment. A SHIP order of a tenant
 * whose `fulfilment_model` is `ship` is settled at SHIPMENT; the delivered reconcile
 * (`reconcileDeliveredOrdersInTx` -> `rebuildIssuedDepositMirrorOnDelivery`) must not restate its
 * issued deposit invoice, even when the delivery came back short.
 *
 * Real: PrismaService, InvoicesService, FeatureConfigService + FeatureConfigStore (the mode is read
 * from a real TenantFeatureConfig row), RegulatedLedgerService. Stubbed: the usual invoices-spec
 * collaborators, none of which the rebuild's money depends on.
 *
 * Runs only under `npm run local:test:db` (jest.db.config.js). Every tenant is a throwaway
 * `qa-3204-<run>-<n>` slug approved by `assertTestTenant`, deleted in FK order in afterAll.
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
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { EstimatesService } from "../estimates/estimates.service";
import { NumberingService } from "../import/numbering.service";
import { FeatureConfigService } from "../billing/feature-config.service";
import { FeatureConfigStore } from "../billing/feature-config.store";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);

describeDb(
  "a SHIP order billed at shipment keeps its issued deposit invoice through DELIVERED (SA-667e)",
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
          FeatureConfigStore,
          {
            provide: FeatureConfigService,
            useFactory: (p: PrismaService, store: FeatureConfigStore) =>
              new FeatureConfigService(p, store, {} as any, {} as any, {} as any, {} as any),
            inject: [PrismaService, FeatureConfigStore],
          },
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
        await prisma.paymentCounter.deleteMany(where).catch(swallow);
        await prisma.invoiceItem.deleteMany(where).catch(swallow);
        await prisma.invoice.deleteMany(where).catch(swallow);
        await prisma.deliveryMutation.deleteMany(where).catch(swallow);
        await prisma.orderItem.deleteMany(where).catch(swallow);
        await prisma.order.deleteMany(where).catch(swallow);
        await prisma.product.deleteMany(where).catch(swallow);
        await prisma.customer.deleteMany(where).catch(swallow);
        await prisma.user.deleteMany(where).catch(swallow);
        await prisma.tenantFeatureConfig.deleteMany(where).catch(swallow);
        await prisma.auditLog.deleteMany(where).catch(swallow);
        await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
      }
      await prisma?.$disconnect();
    });

    /**
     * A `ship`-mode tenant, one SHIP order (2 x $25, tax $5) that is ALREADY shipped (OUT_FOR_DELIVERY,
     * shippedAt stamped), and its issued deposit invoice (50%, SENT, 50 / 5 / 55). Delivery then
     * comes back short, 1 of 2, shaped as completeStop writes it.
     */
    async function seedShipped(label: string) {
      seq += 1;
      const slug = assertTestTenant(
        `qa-3204-${RUN}-${seq}-${label}`,
        "shipment-billing-moment.db.spec.ts",
      );
      const tenant = await prisma.tenant.create({ data: { slug, name: `SA-667e ${slug}` } });
      tenantIds.push(tenant.id);
      const tenantId = tenant.id;
      await prisma.tenantFeatureConfig.create({
        data: { tenantId, featureKey: "fulfilment_model", mode: "ship", reason: "SA-667e pin" },
      });
      const user = await prisma.user.create({
        data: { email: `${slug}@example.invalid`, username: slug, role: "CUSTOMER", tenantId },
      });
      const customer = await prisma.customer.create({
        data: { userId: user.id, businessName: `c ${label}`, contactName: `c ${label}`, tenantId },
      });
      const product = await prisma.product.create({
        data: { tenantId, name: `p ${label}`, unit: "each", pricePerUnit: 25 },
      });
      const order = await prisma.order.create({
        data: {
          tenantId,
          customerId: customer.id,
          fulfillPath: "SHIP",
          status: "OUT_FOR_DELIVERY",
          shippedAt: new Date(),
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
          qty: 2,
          unitPrice: 25,
          subtotal: 50,
        },
      });
      const invoice = await prisma.invoice.create({
        data: {
          tenantId,
          customerId: customer.id,
          orderId: order.id,
          invoiceNumber: `INV-3204-${RUN}-${seq}`,
          status: "SENT",
          depositPercent: 50,
          subtotal: 50,
          taxAmount: 5,
          total: 55,
        },
      });
      await prisma.invoiceItem.create({
        data: {
          tenantId,
          invoiceId: invoice.id,
          orderItemId: li.id,
          productId: product.id,
          description: `p ${label}`,
          qty: 2,
          unitPrice: 25,
          subtotal: 50,
        },
      });
      await prisma.deliveryMutation.create({
        data: {
          tenantId,
          orderId: order.id,
          orderItemId: li.id,
          productId: product.id,
          type: "DELIVERED",
          quantityDelivered: 1,
        },
      });
      return { tenantId, orderId: order.id, invoiceId: invoice.id };
    }

    async function snapshot(invoiceId: string) {
      const inv = await prisma.invoice.findUniqueOrThrow({
        where: { id: invoiceId },
        include: { items: { orderBy: { createdAt: "asc" } } },
      });
      return {
        total: Number(inv.total),
        subtotal: Number(inv.subtotal),
        taxAmount: Number(inv.taxAmount),
        status: inv.status,
        lines: inv.items.map((it) => ({ qty: Number(it.qty), subtotal: Number(it.subtotal) })),
      };
    }

    it("SA-667(e): a shipped SHIP order's SENT deposit invoice is unchanged by DELIVERED, even short", async () => {
      const s = await seedShipped("shipped");
      const before = await snapshot(s.invoiceId);
      expect(before).toMatchObject({ total: 55, subtotal: 50, status: "SENT" });

      await prisma.order.update({ where: { id: s.orderId }, data: { status: "DELIVERED" } });
      await tenantCtx.run(s.tenantId, () =>
        invoices.reconcileDeliveredOrdersInTx(prisma.forTenant(), [s.orderId]),
      );

      expect(await snapshot(s.invoiceId)).toEqual(before); // total, subtotal, tax, status, lines
      const all = await prisma.invoice.findMany({ where: { orderId: s.orderId } });
      expect(all.map((i) => i.id)).toEqual([s.invoiceId]); // no new invoice
    });

    // SA-674(b) is NOT at this base: the guard in rebuildIssuedDepositMirrorOnDelivery keys on
    // billsAtShipment alone (no shippedAt / ship-step condition), so a SHIP order delivered short
    // WITHOUT a ship step is skipped like a shipped one. Write the real case when the fold lands.
    it.todo(
      "SA-674(b): a SHIP order with a deposit delivered short without a ship step restates the mirror on the delivered basis",
    );
  },
);
