/**
 * #2716c / SA-592 — the edited order's NEXT INVOICE carries the edit's classification verbatim:
 * a below-list edit of an existing line persists DISCOUNTED + originalPrice = LIST on the order
 * (through OrdersService.updateOrderItems), and the REAL InvoicesService.createInvoiceFromOrder
 * copies priceType + originalPrice + the net unitPrice onto the invoice line unchanged. Typing the
 * tier price back (tier 1: list) then restores STANDARD before the invoice is cut.
 *
 * Separate file from staff-override-rule.db.spec.ts on purpose: that file mocks the whole
 * InvoicesService module (its OrdersService is built with Object.create and never uses it), while
 * this leg needs the REAL class. The InvoicesService providers mirror
 * invoices/recompute-order-partial.db.spec.ts; the OrdersService construction mirrors
 * staff-override-rule.db.spec.ts.
 *
 * NOT RUN by the lane that wrote it (DB specs are the prover's): F2's DB lane runs it and adjusts
 * any fixture field the schema demands. `requireLocalDatabaseUrl()` refuses any non-local host.
 *
 * SAFETY: one throwaway `qa-2716n-<run>` tenant approved by `assertTestTenant`; `afterAll` deletes
 * exactly the rows this run created, in FK order.
 */
jest.mock("../invoices/invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));

import { Test } from "@nestjs/testing";
import { Logger } from "@nestjs/common";
import { randomUUID } from "crypto";
import { InvoicesService } from "../invoices/invoices.service";
import { InvoicePdfService } from "../invoices/invoice-pdf.service";
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
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { EstimatesService } from "../estimates/estimates.service";
import { NumberingService } from "../import/numbering.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { OrdersService } from "./orders.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { INVOICE_EDIT_STUBS } from "./testing/invoice-edit-stubs";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("#2716c — edited order's next invoice copies DISCOUNTED + list, real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let invoicesService: InvoicesService;
  let orders: any;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-2716n-${run}`, "staff-override-next-invoice.db.spec.ts");
  let tenantId = "";
  let operatorUserId = "";
  let buyerUserId = "";
  let customerId = "";
  let productId = "";
  const orderIds: string[] = [];

  const operator = (): JwtPayload =>
    ({
      sub: operatorUserId,
      username: `op-${run}`,
      role: "OPERATOR",
      status: "ACTIVE",
      forcePasswordChange: false,
      tenantId,
      tenantSlug: slug,
    }) as JwtPayload;

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();

    const moduleRef = await Test.createTestingModule({
      providers: [
        InvoicesService,
        EstimatesService,
        NumberingService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: SellingRestrictionsService,
          useValue: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
        },
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
            sendInvoice: jest.fn().mockResolvedValue({ delivered: true, transport: "resend" }),
            isEmailConfigured: jest.fn().mockResolvedValue(true),
          },
        },
        { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
        {
          provide: SystemConfigService,
          useValue: {
            get: jest.fn().mockResolvedValue(null),
            set: jest.fn().mockResolvedValue(undefined),
          },
        },
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
          useValue: {
            notify: jest.fn().mockResolvedValue([]),
            notifyEvent: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: StorageService,
          useValue: {
            upload: jest.fn().mockResolvedValue("stored"),
            presignedUrl: jest.fn().mockResolvedValue("https://signed/url"),
            delete: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: EntitlementAuthority,
          inject: [EntitlementsService],
          useFactory: (e: { hasFlag?: (t: string, k: string) => Promise<boolean> }) => ({
            can: (t: string, k: string) => e.hasFlag?.(t, k) ?? Promise.resolve(false),
          }),
        },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
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
    invoicesService = moduleRef.get(InvoicesService);

    // OrdersService the way staff-override-rule.db.spec.ts builds it (no Nest DI); the edit path
    // never cuts an invoice, so its invoicesService is the same inert stub.
    orders = Object.assign(Object.create(OrdersService.prototype), {
      prisma,
      gateway: { emitOrderStatusChanged: jest.fn(), emitOrderCreated: jest.fn() },
      systemConfig: moduleRef.get(SystemConfigService),
      entitlements: { hasFlag: async () => true },
      sellingRestrictions: {
        getPolicy: async () => ({ enabled: false, addressPrecedence: "BILLING_FIRST" }),
        assertLinesSellable: async () => undefined,
      },
      authGuard: { assertAuthorizedOrThrow: async () => undefined },
      promotionsService: { activeForCatalog: async () => [] },
      tenantCtx,
      invoicesService: {
        revertLinkedInvoicesForOrderEdit: async () => undefined,
        resyncOrderInvoicesForEdit: async () => [],
        ...INVOICE_EDIT_STUBS,
        reconcileOrderDraftInvoice: async () => undefined,
      },
      logger: new Logger(OrdersService.name),
      inlineReturns: {},
      creditNotes: { settleOrderCreditsInTx: async () => ({ applied: 0, unapplied: 0 }) },
    });

    tenantId = (await prisma.tenant.create({ data: { slug, name: `2716n ${slug}` } })).id;
    operatorUserId = (
      await prisma.user.create({
        data: { email: `o-${run}@example.test`, username: `o-${run}`, role: "OPERATOR", tenantId },
      })
    ).id;
    buyerUserId = (
      await prisma.user.create({
        data: { email: `b-${run}@example.test`, username: `b-${run}`, role: "CUSTOMER", tenantId },
      })
    ).id;
    customerId = (
      await prisma.customer.create({
        data: { userId: buyerUserId, businessName: "2716n co", contactName: "Tester", tenantId },
      })
    ).id;
    productId = (
      await prisma.product.create({
        data: { name: `widget ${run}`, unit: "Each", pricePerUnit: "6.00", tenantId },
      })
    ).id;
  }, 120_000);

  afterAll(async () => {
    await prisma?.invoiceItem.deleteMany({ where: { tenantId } });
    await prisma?.invoice.deleteMany({ where: { tenantId } });
    await prisma?.orderRevision?.deleteMany?.({ where: { orderId: { in: orderIds } } });
    await prisma?.orderItem.deleteMany({ where: { tenantId } });
    await prisma?.order.deleteMany({ where: { tenantId } });
    await prisma?.product.deleteMany({ where: { tenantId } });
    await prisma?.customer.deleteMany({ where: { tenantId } });
    await prisma?.user.deleteMany({ where: { tenantId } });
    await prisma?.tenant.deleteMany({ where: { id: tenantId } });
    await prisma?.$disconnect();
  }, 120_000);

  /** A PENDING order with one STANDARD line at list 6, three delivered. */
  async function seedOrder() {
    const o = await prisma.order.create({
      data: {
        customerId,
        tenantId,
        status: "PENDING",
        subtotal: "18.00",
        total: "18.00",
        lineItems: {
          create: [
            {
              tenantId,
              productId,
              qty: 3,
              deliveredQty: 3,
              unitPrice: "6.00",
              subtotal: "18.00",
              priceType: "STANDARD",
            },
          ],
        },
      },
      include: { lineItems: true },
    });
    orderIds.push(o.id);
    return o;
  }
  const edit = (orderId: string, lineId: string, unitPrice: number, reason?: string) =>
    tenantCtx.run(tenantId, () =>
      orders.updateOrderItems(
        orderId,
        {
          replaceAll: false,
          items: [
            {
              id: lineId,
              action: "UPDATE",
              qty: 3,
              unitPrice,
              ...(reason ? { overrideReason: reason } : {}),
            },
          ],
        },
        operator(),
      ),
    );
  /** Cut the order's invoice with the REAL service and return its line for the order line. */
  async function invoiceLine(orderId: string, lineId: string) {
    await prisma.order.update({ where: { id: orderId }, data: { status: "PARTIALLY_DELIVERED" } });
    await tenantCtx.run(tenantId, () => invoicesService.createInvoiceFromOrder(orderId));
    return prisma.invoiceItem.findFirstOrThrow({ where: { orderItemId: lineId } });
  }

  it("a below-list edit's next invoice carries DISCOUNTED, originalPrice = list, net unitPrice", async () => {
    const o = await seedOrder();
    const lineId = o.lineItems[0].id;
    await edit(o.id, lineId, 4, "deal");
    const stored = await prisma.orderItem.findUniqueOrThrow({ where: { id: lineId } });
    expect(stored.priceType).toBe("DISCOUNTED");
    const item = await invoiceLine(o.id, lineId);
    expect(item.priceType).toBe("DISCOUNTED");
    expect(Number(item.originalPrice)).toBe(6);
    expect(Number(item.unitPrice)).toBe(4);
    expect(Number(item.discount)).toBe(0);
  });

  it("typing list back (tier 1) restores STANDARD, so the next invoice carries STANDARD with no original", async () => {
    const o = await seedOrder();
    const lineId = o.lineItems[0].id;
    await edit(o.id, lineId, 4, "deal");
    await edit(o.id, lineId, 6);
    const stored = await prisma.orderItem.findUniqueOrThrow({ where: { id: lineId } });
    expect({ t: stored.priceType, r: stored.overrideReason, o: stored.originalPrice }).toEqual({
      t: "STANDARD",
      r: null,
      o: null,
    });
    const item = await invoiceLine(o.id, lineId);
    expect(item.priceType).toBe("STANDARD");
    expect(item.originalPrice).toBeNull();
    expect(Number(item.unitPrice)).toBe(6);
  });
});
