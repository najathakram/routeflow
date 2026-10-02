/**
 * #2268 — real-Postgres pin: `resyncOrderInvoicesForEdit` (the post-delivery order-edit resync)
 * used to BAIL on any invoice line with no orderItemId, so one bounced check's system NSF fee line
 * froze the invoice: after a later order edit its product line and totals stayed stale forever.
 * Now the NSF line is skipped by the partition (the shared `isNsfLine` predicate) and kept, as the
 * SAME row, by the rebuild (`preservedNsfLines`, #2242); the rest re-syncs, with the fee in the
 * subtotal and total and outside the tax.
 *
 * Real: PrismaService, InvoicesService, RegulatedLedgerService. The stubbed collaborators are the
 * same set nsf-rebuild-2242.db.spec.ts stubs, none of which the resync's money depends on.
 *
 * Runs only under `npm run local:test:db` (jest.db.config.js). Every tenant is a throwaway
 * `qa-2268-<run>-<n>` slug approved by `assertTestTenant`, deleted in FK order in afterAll.
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
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { EstimatesService } from "../estimates/estimates.service";
import { NumberingService } from "../import/numbering.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);

describeDb(
  "a post-delivery order edit re-syncs an ISSUED invoice that carries an NSF fee line (#2268)",
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
          entitlementAuthorityFromEntitlements, // #2241: EntitlementAuthority
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
        await prisma.trackedCategory.deleteMany(where).catch(swallow);
        await prisma.customer.deleteMany(where).catch(swallow);
        await prisma.user.deleteMany(where).catch(swallow);
        await prisma.auditLog.deleteMany(where).catch(swallow);
        await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
      }
      await prisma?.$disconnect();
    });

    /**
     * A DELIVERED order, 10 × $5 (tax $5), wholly invoiced by ONE ISSUED (SENT) invoice. A $20
     * check then bounces with a $25 NSF fee through the real writers (invoice → 75 / 5 / 80).
     * `legacy` clears systemKind afterwards: a line booked before #2169's stamp.
     */
    async function seed(label: string, legacy: boolean) {
      seq += 1;
      const slug = assertTestTenant(`qa-2268-${RUN}-${seq}-${label}`, "resync-nsf-2268.db.spec.ts");
      const tenant = await prisma.tenant.create({ data: { slug, name: `#2268 ${slug}` } });
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
          status: "DELIVERED",
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
          invoicedQty: 10, // wholly invoiced: the resync's caller-enforced precondition
        },
      });
      const invoice = await prisma.invoice.create({
        data: {
          tenantId,
          customerId: customer.id,
          orderId: order.id,
          invoiceNumber: `INV-2268-${RUN}-${seq}`,
          status: "SENT",
          subtotal: 50,
          taxAmount: 5,
          total: 55,
        },
      });
      const goods = await prisma.invoiceItem.create({
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
      await tenantCtx.run(tenantId, () =>
        invoices.recordPayment(invoice.id, { amount: 20, method: "CHECK" } as any),
      );
      const check = await prisma.invoicePayment.findFirstOrThrow({
        where: { invoiceId: invoice.id, method: "CHECK" },
      });
      await tenantCtx.run(tenantId, () =>
        invoices.setCheckStatus(invoice.id, check.id, { status: "BOUNCED", nsfFeeAmount: 25 }),
      );
      const nsf = await prisma.invoiceItem.findFirstOrThrow({
        where: { invoiceId: invoice.id, systemKind: InvoiceItemSystemKind.NSF_FEE },
      });
      if (legacy) {
        await prisma.invoiceItem.update({ where: { id: nsf.id }, data: { systemKind: null } });
      }
      return { tenantId, orderId: order.id, lineId: li.id, invoiceId: invoice.id, goods, nsf };
    }

    /** The post-delivery edit as the order side leaves it: 10 → 12 units, subtotal 60, tax 6. */
    async function editQtyTo12(s: { orderId: string; lineId: string }) {
      await prisma.orderItem.update({ where: { id: s.lineId }, data: { qty: 12, subtotal: 60 } });
      await prisma.order.update({
        where: { id: s.orderId },
        data: { subtotal: 60, tax: 6, total: 66 },
      });
    }

    it.each([
      ["a stamped (systemKind NSF_FEE) line", false],
      ["a legacy prefix-only (NULL systemKind) line", true],
    ])(
      "with %s: the product line and totals re-sync; the NSF line is the same row, unchanged",
      async (_n, legacy) => {
        const s = await seed(legacy ? "legacy" : "stamped", legacy);
        const before = await prisma.invoice.findUniqueOrThrow({ where: { id: s.invoiceId } });
        expect(Number(before.subtotal)).toBe(75); // goods 50 + fee 25
        expect(Number(before.total)).toBe(80);
        await editQtyTo12(s);

        const updated: any = await tenantCtx.run(s.tenantId, () =>
          invoices.resyncOrderInvoicesForEdit(s.orderId),
        );
        expect(updated?.map((i: any) => i.id)).toEqual([s.invoiceId]); // resynced, not a bail

        const kept = await prisma.invoiceItem.findUnique({ where: { id: s.nsf.id } });
        expect(kept).not.toBeNull(); // the SAME row, not deleted and re-created
        expect(Number(kept!.subtotal)).toBe(25);
        expect(Number(kept!.taxRate)).toBe(0);
        expect(kept!.description).toBe(s.nsf.description);

        const inv = await prisma.invoice.findUniqueOrThrow({
          where: { id: s.invoiceId },
          include: { items: true },
        });
        expect(inv.items).toHaveLength(2); // one rebuilt order line + the kept NSF line
        const goods = inv.items.find((it) => it.id !== s.nsf.id)!;
        expect(goods.orderItemId).toBe(s.lineId);
        expect(Number(goods.qty)).toBe(12);
        expect(Number(goods.subtotal)).toBe(60);
        expect(Number(inv.subtotal)).toBe(85); // goods 60 + fee 25
        expect(Number(inv.taxAmount)).toBe(6); // the order's tax, on goods only
        expect(Number(inv.total)).toBe(91);
        expect(inv.status).not.toBe("DRAFT"); // an issued invoice keeps its lifecycle
        expect(inv.status).not.toBe("PAID"); // the bounced check counts 0

        const line = await prisma.orderItem.findUniqueOrThrow({ where: { id: s.lineId } });
        expect(Number(line.invoicedQty)).toBe(12);
      },
    );

    it("control: a freeform (non-NSF) line with no provenance still bails — nothing is written", async () => {
      const s = await seed("freeform", false);
      await prisma.invoiceItem.create({
        data: {
          tenantId: s.tenantId,
          invoiceId: s.invoiceId,
          description: "Handling",
          qty: 1,
          unitPrice: 3,
          subtotal: 3,
        },
      });
      const before = await prisma.invoice.findUniqueOrThrow({ where: { id: s.invoiceId } });
      await editQtyTo12(s);

      const updated = await tenantCtx.run(s.tenantId, () =>
        invoices.resyncOrderInvoicesForEdit(s.orderId),
      );
      expect(updated).toBeNull();

      const items = await prisma.invoiceItem.findMany({ where: { invoiceId: s.invoiceId } });
      expect(items).toHaveLength(3); // goods + NSF + freeform, all untouched
      expect(Number(items.find((it) => it.id === s.goods.id)!.qty)).toBe(10);
      const after = await prisma.invoice.findUniqueOrThrow({ where: { id: s.invoiceId } });
      expect(Number(after.total)).toBe(Number(before.total));
    });
  },
);
