/**
 * #2178 (Opus L1 on #2139; Opus fold on #2426) — real-Postgres pins for the order-edit inline-return
 * preflight pricing against the matching set AS IT WILL BE after the edit's linked-invoice revert.
 *
 * (a) Through OrdersService.updateOrderItems with the REAL InvoicesService revert
 *     (`revertLinkedInvoicesForOrderEdit`) and the invoice created by the REAL writer
 *     (`createInvoiceFromOrder`): a boxed return whose ONLY pack evidence is this undelivered order's own
 *     SENT invoice refuses INLINE_RETURN_PACK_UNKNOWN in the PREFLIGHT, so the invoice is still SENT
 *     (the revert never ran), no credit-note number is reserved and the order is unchanged.
 * (b) The exclusion DISCRIMINATES: the same return priced by the real preflight WITHOUT the revert set
 *     (the pre-#2178 behaviour) and WITH it gives different totals, because the pre-revert set's newest
 *     match (this order's own SENT invoice, $10/ea) drops out and the post-revert set prices from an
 *     older delivered invoice ($4/ea).
 *
 * The created invoice is flipped DRAFT → SENT with a raw write: `send()` refuses an undelivered order's
 * pending mirror ("invoice after delivery"), and a SENT pending mirror is exactly the precondition the
 * revert exists for (deposit-collect-at-order issuance and pre-rule rows).
 *
 * Real InvoicesService via a Nest TestingModule (as invoice-issue-date-b2197.db.spec.ts builds it); real
 * InlineReturnsService / OrdersService via `Object.create` (as orders-inline-return-edit.db.spec.ts). NOT
 * RUN by the lane that wrote it (DB specs are the prover's): F2's DB lane runs it and adjusts any fixture
 * field the schema demands.
 *
 * SAFETY: one throwaway `qa-2178-<run>` tenant approved by `assertTestTenant`; `afterAll` deletes exactly
 * the rows this run created.
 */
jest.mock("../invoices/invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({ getOrGenerate: jest.fn() })),
}));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));

import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { Logger } from "@nestjs/common";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { EncryptionService } from "../common/encryption.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { NumberingService } from "../import/numbering.service";
import { IdempotencyService } from "../common/idempotency.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { InlineReturnsQuoteService } from "./inline-returns-quote.service";
import { InlineReturnsService } from "./inline-returns.service";
import { InvoicesService } from "../invoices/invoices.service";
import { InvoicePdfService } from "../invoices/invoice-pdf.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { EmailService } from "../email/email.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { MessagingService } from "../messaging/messaging.service";
import { StorageService } from "../storage/storage.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { OrdersService } from "../orders/orders.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";
import { INVOICE_EDIT_STUBS } from "../orders/testing/invoice-edit-stubs";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb(
  "#2178 — the edit-return preflight prices against the post-revert set, real Postgres",
  () => {
    let pool: Pool;
    let raw: PrismaClient;
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let invoices: InvoicesService;
    let inlineSvc: any;
    let creditNotesSvc: any;
    let orders: any;
    let reserved: string[] = [];
    const run = randomUUID().slice(0, 8);
    const slug = assertTestTenant(`qa-2178-${run}`, "inline-return-preflight-revert.db.spec.ts");
    let tenantId = "";
    let customerId = "";
    const userIds: string[] = [];
    const productIds: string[] = [];
    const orderIds: string[] = [];

    const staff = (): JwtPayload =>
      ({
        sub: userIds[0] ?? "op",
        username: "operator",
        role: "OPERATOR",
        status: "ACTIVE",
        forcePasswordChange: false,
        tenantId,
        tenantSlug: slug,
      }) as JwtPayload;

    const product = async (tag: string, unitsPerBox: number | null, price: string) => {
      const p = await raw.product.create({
        data: {
          name: `${tag} p ${run}`,
          unit: unitsPerBox ? "Box" : "each",
          unitsPerBox,
          pricePerUnit: price,
          currentStock: "1000",
          tenantId,
        },
      });
      productIds.push(p.id);
      return p.id;
    };

    /** An order with one line, invoiced by the REAL writer, the invoice flipped to SENT (see header). */
    async function invoicedOrder(p: {
      productId: string;
      status: string;
      line: {
        qty: number;
        unitPrice: string;
        subtotal: string;
        boxes?: number;
        pieces?: number;
        unitsPerBox?: number;
      };
      issueDate?: Date;
    }) {
      const o = await raw.order.create({
        data: {
          customerId,
          tenantId,
          status: p.status as any,
          subtotal: String(p.line.subtotal),
          total: String(p.line.subtotal),
          lineItems: { create: [{ tenantId, productId: p.productId, ...p.line }] },
        },
      });
      orderIds.push(o.id);
      await tenantCtx.run(tenantId, () => invoices.createInvoiceFromOrder(o.id));
      const inv = await raw.invoice.findFirstOrThrow({ where: { orderId: o.id } });
      await raw.invoice.update({
        where: { id: inv.id },
        data: { status: "SENT", ...(p.issueDate ? { issueDate: p.issueDate } : {}) },
      });
      return { orderId: o.id, invoiceId: inv.id };
    }

    beforeAll(async () => {
      pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
      raw = new PrismaClient({ adapter: new PrismaPg(pool) });
      tenantCtx = new TenantContextService();
      prisma = new PrismaService(tenantCtx);
      await prisma.$connect();
      const numbering = new NumberingService(prisma);
      const ledger = new RegulatedLedgerService(prisma);
      const systemConfig = new SystemConfigService(
        prisma,
        new EncryptionService({ get: () => undefined } as any),
      );
      const mockCreditNotes = {
        autoApplyOldestCreditsInTx: jest
          .fn()
          .mockResolvedValue({ applied: 0, invoiceStatus: null }),
        settleOrderCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, unapplied: 0 }),
        releaseInvoiceCreditsInTx: jest.fn().mockResolvedValue([]),
      };
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          InvoicesService,
          {
            provide: SellingRestrictionsService,
            useValue: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
          },
          { provide: NumberingService, useValue: numbering },
          { provide: PrismaService, useValue: prisma },
          {
            provide: RouteFlowGateway,
            useValue: { emitInvoiceUpdated: jest.fn(), emitOrderStatusChanged: jest.fn() },
          },
          {
            provide: EmailService,
            useValue: { sendInvoice: jest.fn(), isEmailConfigured: jest.fn() },
          },
          { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
          { provide: SystemConfigService, useValue: systemConfig },
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
          {
            provide: MessagingService,
            useValue: { notify: jest.fn(), notifyEvent: jest.fn() },
          },
          { provide: StorageService, useValue: { upload: jest.fn(), delete: jest.fn() } },
          {
            provide: EntitlementsService,
            useValue: { hasFlag: jest.fn().mockResolvedValue(false) },
          },
          entitlementAuthorityFromEntitlements, // #2241
          {
            provide: CommissionEngineService,
            useValue: {
              syncInvoiceCommissionSafe: jest.fn(),
              syncOrderInvoices: jest.fn(),
              removeInvoiceCommission: jest.fn(),
            },
          },
        ],
      }).compile();
      invoices = module.get(InvoicesService);

      const creditNotes = Object.assign(Object.create(CreditNotesService.prototype), {
        prisma,
        gateway: { emitCreditNoteCreated: jest.fn() },
        ledger,
        commissionEngine: {
          syncInvoiceCommissionSafe: async () => undefined,
          syncOrderInvoices: async () => undefined,
          removeInvoiceCommission: async () => undefined,
        },
        numbering,
        logger: new Logger(CreditNotesService.name),
      });
      creditNotesSvc = creditNotes;
      inlineSvc = Object.assign(Object.create(InlineReturnsService.prototype), {
        prisma,
        gateway: { emitCreditNoteCreated: jest.fn() },
        ledger,
        creditNotes,
        numbering,
        addonService: { hasAddon: async () => true },
        quoteService: new InlineReturnsQuoteService(prisma, systemConfig),
        idempotency: new IdempotencyService(),
      });
      const realReserve = inlineSvc.reserveCreditNoteNumber.bind(inlineSvc);
      inlineSvc.reserveCreditNoteNumber = async () => {
        const n = await realReserve();
        reserved.push(n);
        return n;
      };
      // The REAL revert; only the post-commit reconcile hooks are quieted (not under test here).
      const invoicesForOrders = Object.assign(Object.create(invoices), {
        reconcileOrderDraftInvoice: async () => undefined,
        resyncOrderInvoicesForEdit: async () => [],
        ...INVOICE_EDIT_STUBS,
      });
      orders = Object.assign(Object.create(OrdersService.prototype), {
        prisma,
        gateway: { emitOrderStatusChanged: jest.fn(), emitOrderCreated: jest.fn() },
        systemConfig,
        entitlements: { hasFlag: async () => true },
        sellingRestrictions: {
          assertLinesSellable: async () => undefined,
          getPolicy: async () => ({ enabled: false, addressPrecedence: "BILLING_FIRST" }),
        },
        authGuard: { assertAuthorizedOrThrow: async () => undefined },
        promotionsService: { activeForCatalog: async () => [] },
        creditNotes,
        ledger,
        tenantCtx,
        invoicesService: invoicesForOrders,
        logger: new Logger(OrdersService.name),
        inlineReturns: inlineSvc,
      });

      tenantId = (await raw.tenant.create({ data: { slug, name: `2178 ${slug}` } })).id;
      const op = await raw.user.create({
        data: {
          email: `op-${run}@example.test`,
          username: `op-${run}`,
          role: "OPERATOR",
          tenantId,
        },
      });
      userIds.push(op.id);
      const buyer = await raw.user.create({
        data: { email: `b-${run}@example.test`, username: `b-${run}`, role: "CUSTOMER", tenantId },
      });
      userIds.push(buyer.id);
      customerId = (
        await raw.customer.create({
          data: { userId: buyer.id, businessName: "2178 co", contactName: "Tester", tenantId },
        })
      ).id;
    }, 120_000);

    beforeEach(() => {
      reserved = [];
    });

    afterAll(async () => {
      await raw.orderCreditNote.deleteMany({ where: { orderId: { in: orderIds } } });
      await raw.returnItem.deleteMany({ where: { return: { orderId: { in: orderIds } } } });
      await raw.return.deleteMany({ where: { orderId: { in: orderIds } } });
      await raw.creditNote.deleteMany({ where: { tenantId } });
      await raw.invoicePayment.deleteMany({ where: { invoice: { tenantId } } });
      await raw.invoiceItem.deleteMany({ where: { invoice: { tenantId } } });
      await raw.invoice.deleteMany({ where: { tenantId } });
      await raw.orderRevision?.deleteMany?.({ where: { orderId: { in: orderIds } } });
      await raw.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
      await raw.order.deleteMany({ where: { id: { in: orderIds } } });
      await raw.stockMovement.deleteMany({ where: { productId: { in: productIds } } });
      await raw.product.deleteMany({ where: { id: { in: productIds } } });
      await raw.customer.deleteMany({ where: { id: customerId } });
      await raw.user.deleteMany({ where: { id: { in: userIds } } });
      await raw.numberingSequence?.deleteMany?.({ where: { tenantId } });
      await raw.tenant.deleteMany({ where: { id: tenantId } });
      await prisma?.$disconnect();
      await raw?.$disconnect();
      await pool?.end();
    }, 120_000);

    it("(a) REAL revert + REAL writer: the pack-only-own-invoice boxed return refuses in the preflight; the invoice stays SENT", async () => {
      // A 12-pack sold as 1 box; the invoice snapshots unitsPerBox 12. Then the product loses its pack,
      // so this order's own SENT invoice is the ONLY pack evidence for a boxed return.
      const productId = await product("pack", 12, "10.00");
      const f = await invoicedOrder({
        productId,
        status: "PENDING",
        line: {
          qty: 12,
          boxes: 1,
          pieces: 0,
          unitsPerBox: 12,
          unitPrice: "10.00",
          subtotal: "10.00",
        },
      });
      await raw.product.update({ where: { id: productId }, data: { unitsPerBox: null } });
      const before = await raw.order.findUniqueOrThrow({ where: { id: f.orderId } });

      await expect(
        tenantCtx.run(tenantId, () =>
          orders.updateOrderItems(
            f.orderId,
            {
              items: [{ productId, qty: 12, boxes: 1, pieces: 0 }],
              inlineReturn: {
                items: [{ productId, qty: 1, boxes: 1, pieces: 0 }],
                returnKey: `k-pack-${run}`,
              },
            },
            staff(),
          ),
        ),
      ).rejects.toMatchObject({ response: { code: "INLINE_RETURN_PACK_UNKNOWN" } });

      expect((await raw.invoice.findUniqueOrThrow({ where: { id: f.invoiceId } })).status).toBe(
        "SENT",
      );
      expect(reserved).toHaveLength(0);
      const after = await raw.order.findUniqueOrThrow({ where: { id: f.orderId } });
      expect(Number(after.total)).toBe(Number(before.total));
      expect(await raw.return.count({ where: { orderId: f.orderId } })).toBe(0);
    }, 60_000);

    it("(b) the exclusion DISCRIMINATES: the same return prices differently with and without the revert set", async () => {
      const productId = await product("disc", null, "10.00");
      // An OLDER delivered order's SENT invoice at $4/ea (in the matching set before AND after the revert).
      await invoicedOrder({
        productId,
        status: "DELIVERED",
        line: { qty: 5, unitPrice: "4.00", subtotal: "20.00" },
        issueDate: new Date(Date.now() - 2 * 86_400_000),
      });
      // THIS undelivered order's own SENT invoice at $10/ea: newest, so it prices the return pre-revert;
      // the edit's revert makes it a DRAFT of an undelivered order, out of the post-revert set.
      const current = await invoicedOrder({
        productId,
        status: "PENDING",
        line: { qty: 5, unitPrice: "10.00", subtotal: "50.00" },
      });
      const dto = { customerId, orderId: current.orderId, items: [{ productId, qty: 2 }] };
      const price = (opts?: { revertOrderId?: string }) =>
        tenantCtx.run(tenantId, () =>
          inlineSvc.preflightCapture(dto, staff(), { routeRunId: null }, opts ?? {}),
        );

      const preRevert = Number(await price()); // the pre-#2178 behaviour: this order's $10 line
      const postRevert = Number(await price({ revertOrderId: current.orderId })); // the older $4 line

      expect(preRevert).toBeCloseTo(20, 2);
      expect(postRevert).toBeCloseTo(8, 2);
      expect(postRevert).not.toBeCloseTo(preRevert, 2);
    }, 60_000);

    it("(c) B948 (B215 class): an inline return over a source line's remaining headroom refuses 409 IN THE PREFLIGHT: the edited order's SENT invoice stays SENT and no credit-note number is burned", async () => {
      const productId = await product("headroom", null, "10.00");
      // An OLDER delivered order's SENT invoice: 5 x $10 = $50, of which a credit note item already took $40 (4 pcs).
      const older = await invoicedOrder({
        productId,
        status: "DELIVERED",
        line: { qty: 5, unitPrice: "10.00", subtotal: "50.00" },
        issueDate: new Date(Date.now() - 2 * 86_400_000),
      });
      const oldLine = await raw.invoiceItem.findFirstOrThrow({
        where: { invoiceId: older.invoiceId },
      });
      await tenantCtx.run(tenantId, () =>
        creditNotesSvc.create({
          customerId,
          invoiceId: older.invoiceId,
          amount: 40,
          items: [{ invoiceItemId: oldLine.id, amount: 40, qty: 4 }],
        }),
      );
      const current = await invoicedOrder({
        productId,
        status: "PENDING",
        line: { qty: 5, unitPrice: "10.00", subtotal: "50.00" },
      });

      // post-revert the return prices from the older line (5 pcs = $50 > the $10 left on it)
      await expect(
        tenantCtx.run(tenantId, () =>
          orders.updateOrderItems(
            current.orderId,
            {
              items: [{ productId, qty: 5 }],
              inlineReturn: { items: [{ productId, qty: 5 }], returnKey: `k-head-${run}` },
            },
            staff(),
          ),
        ),
      ).rejects.toMatchObject({ response: { code: "RETURN_REFUND_OVER_LINE_HEADROOM" } });

      expect(
        (await raw.invoice.findUniqueOrThrow({ where: { id: current.invoiceId } })).status,
      ).toBe("SENT"); // never reverted to DRAFT
      expect(reserved).toHaveLength(0); // no CN number reserved (so none burned)
      expect(await raw.return.count({ where: { orderId: current.orderId } })).toBe(0);
    }, 60_000);
  },
);
