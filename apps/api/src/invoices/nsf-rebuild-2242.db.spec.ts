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
 * #2387 fold (#938 5852033790): the same row also survives `rebuildSiblingDrafts`, the second
 * rebuild path, through its two reachable callers: the delivered reconcile of a SENT deposit
 * mirror (rebuildIssuedDepositMirrorOnDelivery) and the split-sibling reconcile
 * (reconcileSplitOrderDrafts).
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
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";

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
        await prisma.trackedCategory.deleteMany(where).catch(swallow);
        await prisma.customer.deleteMany(where).catch(swallow);
        await prisma.user.deleteMany(where).catch(swallow);
        await prisma.auditLog.deleteMany(where).catch(swallow);
        await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
      }
      await prisma?.$disconnect();
    });

    /**
     * A PENDING order (10 × $5 = $50, tax $5) mirrored by ONE issued deposit invoice (SENT,
     * depositPercent 50) that carries the order line plus an NSF fee line of $25, booked by a
     * bounced check (`null` = a legacy prefix-only line from before #2169's stamp).
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
          qty: 10,
          unitPrice: 5,
          subtotal: 50,
        },
      });
      // A $20 check bounces with the $25 fee through the real writers (invoice → 75 / 5 / 80).
      const nsf = await bounceCheck(tenantId, invoice.id, 20, nsfKind === null);
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
    /** A throwaway approved tenant with one customer. */
    async function newTenant(label: string) {
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
      return { tenantId, customerId: customer.id };
    }

    /**
     * The NSF line exactly as production books it (fleet rule: money fixtures are shaped by the
     * REAL writer): a CHECK recorded through recordPayment, then bounced through setCheckStatus
     * with a $25 fee, which writes the stamped (NSF_FEE) line and moves the invoice's subtotal and
     * total. `legacy` then clears systemKind, the one hand edit: the shape of a line booked before
     * #2169's stamp, which only the description prefix identifies.
     */
    async function bounceCheck(
      tenantId: string,
      invoiceId: string,
      amount: number,
      legacy: boolean,
    ) {
      await tenantCtx.run(tenantId, () =>
        invoices.recordPayment(invoiceId, { amount, method: "CHECK" } as any),
      );
      const check = await prisma.invoicePayment.findFirstOrThrow({
        where: { invoiceId, method: "CHECK" },
      });
      await tenantCtx.run(tenantId, () =>
        invoices.setCheckStatus(invoiceId, check.id, { status: "BOUNCED", nsfFeeAmount: 25 }),
      );
      const nsf = await prisma.invoiceItem.findFirstOrThrow({
        where: { invoiceId, systemKind: InvoiceItemSystemKind.NSF_FEE },
      });
      if (legacy) {
        await prisma.invoiceItem.update({ where: { id: nsf.id }, data: { systemKind: null } });
      }
      return nsf;
    }

    it.each([
      ["a stamped (systemKind NSF_FEE) line", false],
      ["a legacy prefix-only (NULL systemKind) line", true],
    ])(
      "#2387 fold: the delivered reconcile of a SENT deposit mirror keeps %s; PARTIAL on goods-only tax",
      async (_n, legacy) => {
        const { tenantId, customerId } = await newTenant(legacy ? "dlv-legacy" : "dlv-stamped");
        const product = await prisma.product.create({
          data: { tenantId, name: "p dlv", unit: "each", pricePerUnit: 25 },
        });
        // Ordered 2 × $25 (tax $5). The legacy deliveredQty column stays 0: the delivered basis
        // must come from the DeliveryMutation evidence row below.
        const order = await prisma.order.create({
          data: { tenantId, customerId, status: "DELIVERED", subtotal: 50, tax: 5, total: 55 },
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
        // The SENT deposit mirror as issued at placement: goods 50 + tax 5 = 55.
        const invoice = await prisma.invoice.create({
          data: {
            tenantId,
            customerId,
            orderId: order.id,
            invoiceNumber: `INV-2242-${RUN}-${seq}`,
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
            description: "p dlv",
            qty: 2,
            unitPrice: 25,
            subtotal: 50,
          },
        });
        // $10 cash confirmed; a $20 check bounces with a $25 NSF fee (invoice → 75 / 5 / 80).
        await tenantCtx.run(tenantId, () =>
          invoices.recordPayment(invoice.id, { amount: 10, method: "CASH" } as any),
        );
        const nsf = await bounceCheck(tenantId, invoice.id, 20, legacy);
        // The short delivery, shaped as completeStop (routes.service.ts) writes it: 1 of 2.
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

        await tenantCtx.run(tenantId, () =>
          invoices.reconcileDeliveredOrdersInTx(prisma.forTenant(), [order.id]),
        );

        const kept = await prisma.invoiceItem.findUnique({ where: { id: nsf.id } });
        expect(kept).not.toBeNull(); // the SAME row
        expect(Number(kept!.subtotal)).toBe(25);
        expect(Number(kept!.taxRate)).toBe(0);
        const inv = await prisma.invoice.findUnique({
          where: { id: invoice.id },
          include: { items: true },
        });
        expect(inv!.items).toHaveLength(2); // the delivered goods line + the kept NSF line
        const goods = inv!.items.find((it) => it.id !== nsf.id)!;
        expect(Number(goods.qty)).toBe(1); // billed from the mutation, not the 0 column
        expect(Number(inv!.subtotal)).toBe(50); // delivered goods 25 + fee 25
        expect(Number(inv!.taxAmount)).toBe(2.5); // the order's tax share on goods only
        expect(Number(inv!.total)).toBe(52.5);
        expect(inv!.status).toBe("PARTIAL"); // $10 confirmed of 52.50; the bounced check counts 0
      },
    );

    it.each([
      ["a stamped (systemKind NSF_FEE) line", false],
      ["a legacy prefix-only (NULL systemKind) line", true],
    ])(
      "#2387 fold: split siblings keep %s; the tax remainder and shipping stay on -R1",
      async (_n, legacy) => {
        const { tenantId, customerId } = await newTenant(legacy ? "split-legacy" : "split");
        const cat = await prisma.trackedCategory.create({
          data: { tenantId, name: "R", invoiceTreatment: "SEPARATE_INVOICE" },
        });
        const pStd = await prisma.product.create({
          data: { tenantId, name: "p std", unit: "each", pricePerUnit: 10 },
        });
        const pReg = await prisma.product.create({
          data: {
            tenantId,
            name: "p reg",
            unit: "each",
            pricePerUnit: 10,
            trackedCategoryId: cat.id,
          },
        });
        // Base: 1 × $10. -R1: 3 × $10. Order tax 0.50, shipping 5 (the drafts carry none → re-seeded).
        const order = await prisma.order.create({
          data: {
            tenantId,
            customerId,
            status: "PENDING",
            subtotal: 40,
            tax: 0.5,
            shippingFee: 5,
            total: 45.5,
          },
        });
        const liStd = await prisma.orderItem.create({
          data: {
            tenantId,
            orderId: order.id,
            productId: pStd.id,
            qty: 1,
            unitPrice: 10,
            subtotal: 10,
          },
        });
        const liReg = await prisma.orderItem.create({
          data: {
            tenantId,
            orderId: order.id,
            productId: pReg.id,
            qty: 3,
            unitPrice: 10,
            subtotal: 30,
            trackedCategoryId: cat.id,
          },
        });
        const groupId = randomUUID();
        const mkDraft = (suffix: string, subtotal: number) =>
          prisma.invoice.create({
            data: {
              tenantId,
              customerId,
              orderId: order.id,
              invoiceGroupId: groupId,
              invoiceNumber: `INV-2242-${RUN}-${seq}${suffix}`,
              status: "DRAFT",
              subtotal,
              taxAmount: 0,
              total: subtotal,
            },
          });
        const base = await mkDraft("", 10);
        const r1 = await mkDraft("-R1", 30);
        await prisma.invoiceItem.create({
          data: {
            tenantId,
            invoiceId: base.id,
            orderItemId: liStd.id,
            productId: pStd.id,
            description: "p std",
            qty: 1,
            unitPrice: 10,
            subtotal: 10,
          },
        });
        await prisma.invoiceItem.create({
          data: {
            tenantId,
            invoiceId: r1.id,
            orderItemId: liReg.id,
            productId: pReg.id,
            description: "p reg",
            qty: 3,
            unitPrice: 10,
            subtotal: 30,
            trackedCategoryId: cat.id,
          },
        });
        // A $5 check on the BASE bounces with the $25 fee. Counted before the proration and fee
        // placement, the base (10 + 25) would outweigh -R1 (30) and take the remainder and shipping.
        const nsf = await bounceCheck(tenantId, base.id, 5, legacy);

        await tenantCtx.run(tenantId, () =>
          invoices.reconcileOrderDraftInvoice(order.id, { basis: "order" }),
        );

        const kept = await prisma.invoiceItem.findUnique({ where: { id: nsf.id } });
        expect(kept?.invoiceId).toBe(base.id);
        expect(Number(kept!.subtotal)).toBe(25);
        expect(Number(kept!.taxRate)).toBe(0);
        const b = await prisma.invoice.findUnique({ where: { id: base.id } });
        const r = await prisma.invoice.findUnique({ where: { id: r1.id } });
        expect(Number(b!.subtotal)).toBe(35); // goods 10 + fee 25
        expect(Number(b!.taxAmount)).toBe(0.13); // round(0.125)
        expect(Number(b!.shippingFee)).toBe(0);
        expect(Number(b!.total)).toBe(35.13);
        expect(Number(r!.subtotal)).toBe(30);
        expect(Number(r!.taxAmount)).toBe(0.37); // round(0.375) = 0.38, less the -0.01 remainder
        expect(Number(r!.shippingFee)).toBe(5);
        expect(Number(r!.total)).toBe(35.37);
      },
    );
  },
);
