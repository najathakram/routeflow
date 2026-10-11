/**
 * B663 — RED repro (sweep, Lane R-ui). A short or refused delivery closed ON ACCOUNT (no payment
 * collected) must bill what was delivered, not the full ordered quantity.
 *
 * The bug: `completeWithPayment` records `deliveredQty` for every delivery line, but the
 * delivered-basis reconcile (`reconcileOrderDraftInvoice` via `recordDeliveryPaymentInTx`) is
 * reached ONLY behind `dto.payment && dto.payment.amount > 0`. An on-account completion (the driver
 * taps "On account", amount 0 / no payment) therefore leaves the order's DRAFT invoice at the FULL
 * ordered quantity — including refused lines — after the driver told the customer "short, see
 * office invoice for final". Not flag-gated.
 *
 * Scenario: a 2-line order (L1: 10 x $10, L2: 4 x $5 = $120) with its DRAFT pending mirror, on a
 * run stop; the driver delivers 6 of L1 (PARTIAL) and REFUSES L2, with NO payment. Correct = the
 * invoice bills L1 x 6 = $60 and L2 x 0; master bills L1 x 10 and L2 x 4 = $120.
 *
 * WHY THE DB LANE: the completion runs one real tenantTransaction across the stop, the delivery
 * mutations, `deliveredQty`, the order status and the invoice reconcile — the outcome (what the
 * invoice bills) is only provable against real Postgres. Collected only by `jest.db.config.js`;
 * run via `npm run local:test:db`. Every collaborator other than Prisma is mocked at the module
 * boundary exactly as `invoice-delete-credit.db.spec.ts` does; the REAL `RoutesService` and
 * `InvoicesService` run.
 *
 * SAFETY: throwaway `qa-b663-<run>-<n>-<label>` tenants approved by `assertTestTenant`; `afterAll`
 * deletes exactly the tenants THIS run created, best-effort.
 */

jest.mock("../invoices/invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({
  compressDocument: jest.fn(),
  compressImage: jest.fn(),
}));

import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "crypto";
import { RoutesService } from "./routes.service";
import { InvoicesService } from "../invoices/invoices.service";
import { InvoicePdfService } from "../invoices/invoice-pdf.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { NotificationsService } from "../notifications/notifications.service";
import { EmailService } from "../email/email.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { MessagingService } from "../messaging/messaging.service";
import { StorageService } from "../storage/storage.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { FeatureConfigService } from "../billing/feature-config.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { EstimatesService } from "../estimates/estimates.service";
import { NumberingService } from "../import/numbering.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
function freshTenantSlug(label: string): string {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-b663-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "complete-on-account-short.db.spec.ts",
  );
}

describeDb("B663 on-account short/refused completion — real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let routesService: RoutesService;
  let invoicesService: InvoicesService;
  const createdTenantIds: string[] = [];

  const mockGateway = {
    emitInvoiceUpdated: jest.fn(),
    emitOrderCreated: jest.fn(),
    emitOrderStatusChanged: jest.fn(),
    emitLowStock: jest.fn(),
    emitStopCompleted: jest.fn(),
    emitUrgentOrder: jest.fn(),
    emitRunUpdated: jest.fn(),
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
  const mockEntitlements = { hasFlag: jest.fn().mockResolvedValue(false) };
  const mockCommissionEngine = {
    syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined),
    syncOrderInvoices: jest.fn().mockResolvedValue(undefined),
    removeInvoiceCommission: jest.fn().mockResolvedValue(undefined),
  };

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RoutesService,
        InvoicesService,
        {
          provide: SellingRestrictionsService,
          useValue: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
        },
        EstimatesService,
        NumberingService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: mockGateway },
        { provide: NotificationsService, useValue: { create: jest.fn(), notify: jest.fn() } },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(undefined) } },
        { provide: FeatureConfigService, useValue: { get: jest.fn(), isEnabled: jest.fn() } },
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
        {
          provide: EntitlementAuthority,
          inject: [EntitlementsService],
          useFactory: (e: { hasFlag?: (t: string, k: string) => Promise<boolean> }) => ({
            can: (t: string, k: string) => e.hasFlag?.(t, k) ?? Promise.resolve(false),
          }),
        },
        { provide: EntitlementsService, useValue: mockEntitlements },
        { provide: CommissionEngineService, useValue: mockCommissionEngine },
      ],
    }).compile();

    routesService = module.get(RoutesService);
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

  async function cleanupTenant(tenantId: string): Promise<void> {
    await prisma.deliveryMutation.deleteMany({ where: { tenantId } });
    await prisma.invoiceItem.deleteMany({ where: { tenantId } });
    await prisma.invoice.deleteMany({ where: { tenantId } });
    await prisma.orderItem.deleteMany({ where: { tenantId } });
    await prisma.order.deleteMany({ where: { tenantId } });
    await prisma.routeRunStop.deleteMany({ where: { tenantId } });
    await prisma.routeRun.deleteMany({ where: { tenantId } });
    await prisma.routeStop.deleteMany({ where: { tenantId } });
    await prisma.route.deleteMany({ where: { tenantId } });
    await prisma.product.deleteMany({ where: { tenantId } });
    await prisma.customer.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  }

  /** Two-line order on a run stop with its DRAFT pending mirror (the office's normal starting state). */
  async function seedOrderOnStop(label: string) {
    const slug = freshTenantSlug(label);
    const tenant = await prisma.tenant.create({ data: { slug, name: `B663 ${slug}` } });
    createdTenantIds.push(tenant.id);
    const tenantId = tenant.id;
    const idBase = `${tenantId}-${label}`;
    const user = await prisma.user.create({
      data: { email: `${idBase}@example.invalid`, username: idBase, role: "CUSTOMER", tenantId },
    });
    const customer = await prisma.customer.create({
      data: {
        userId: user.id,
        businessName: `B663 customer ${label}`,
        contactName: `B663 contact ${label}`,
        tenantId,
      },
    });
    const p1 = await prisma.product.create({
      data: { name: `B663 P1 ${label}`, unit: "each", pricePerUnit: 10, tenantId },
    });
    const p2 = await prisma.product.create({
      data: { name: `B663 P2 ${label}`, unit: "each", pricePerUnit: 5, tenantId },
    });
    const route = await prisma.route.create({ data: { name: `B663 route ${label}`, tenantId } });
    const routeStop = await prisma.routeStop.create({
      data: { routeId: route.id, customerId: customer.id, stopNumber: 1, tenantId },
    });
    const run = await prisma.routeRun.create({
      data: {
        routeId: route.id,
        status: "IN_PROGRESS",
        scheduledDate: new Date(),
        startedAt: new Date(),
        tenantId,
      },
    });
    const runStop = await prisma.routeRunStop.create({
      data: {
        routeRunId: run.id,
        routeStopId: routeStop.id,
        customerId: customer.id,
        stopNumber: 1,
        status: "IN_PROGRESS",
        tenantId,
      },
    });
    const order = await prisma.order.create({
      data: {
        customerId: customer.id,
        status: "OUT_FOR_DELIVERY",
        orderNumber: `B663-${RUN_SUFFIX}-${label}`,
        routeRunId: run.id,
        routeRunStopId: runStop.id,
        subtotal: 120,
        tax: 0,
        total: 120,
        tenantId,
      },
    });
    const line1 = await prisma.orderItem.create({
      data: {
        orderId: order.id,
        productId: p1.id,
        qty: 10,
        unitPrice: 10,
        subtotal: 100,
        tenantId,
      },
    });
    const line2 = await prisma.orderItem.create({
      data: { orderId: order.id, productId: p2.id, qty: 4, unitPrice: 5, subtotal: 20, tenantId },
    });
    // The DRAFT pending mirror, built the same way the office flow builds it.
    await tenantCtx.run(tenantId, () => invoicesService.createInvoiceFromOrder(order.id));
    return { tenantId, order, run, runStop, line1, line2 };
  }

  it("REG-B663: an on-account short/refused completion bills the DELIVERED quantities, not the full order", async () => {
    const s = await seedOrderOnStop("acct");

    const before = await prisma.invoice.findMany({
      where: { orderId: s.order.id, status: { not: "VOID" } },
      include: { items: true },
    });
    // Precondition: the mirror exists at the full ordered quantities.
    expect(before).toHaveLength(1);
    expect(Number(before[0].total)).toBe(120);

    await tenantCtx.run(s.tenantId, () =>
      routesService.completeWithPayment(
        s.run.id,
        s.runStop.id,
        {
          deliveries: [
            { orderItemId: s.line1.id, type: "PARTIAL", quantityDelivered: 6 },
            { orderItemId: s.line2.id, type: "REFUSED", quantityDelivered: 0 },
          ],
          // On account: nothing collected at the door.
        } as never,
        { sub: "b663-operator", role: "OPERATOR" } as never,
      ),
    );

    const invoices = await prisma.invoice.findMany({
      where: { orderId: s.order.id, status: { not: "VOID" } },
      include: { items: true },
    });
    const billedQty = (orderItemId: string) =>
      invoices.flatMap((i) => i.items).find((it) => it.orderItemId === orderItemId)?.qty;

    // Wrong values on master: L1 billed 10, L2 billed 4, invoice total 120 (the full order).
    expect({
      invoiceCount: invoices.length,
      line1Qty: Number(billedQty(s.line1.id) ?? 0),
      line2Qty: Number(billedQty(s.line2.id) ?? 0),
      total: invoices.reduce((sum, i) => sum + Number(i.total), 0),
    }).toEqual({ invoiceCount: 1, line1Qty: 6, line2Qty: 0, total: 60 });
  });

  it("PIN (green on master): the same short/refused completion WITH a cash payment already bills the delivered quantities — the reconcile that on-account skips", async () => {
    const s = await seedOrderOnStop("cash");

    const before = await prisma.invoice.findMany({
      where: { orderId: s.order.id, status: { not: "VOID" } },
      include: { items: true },
    });
    // Precondition: the mirror exists at the full ordered quantities.
    expect(before).toHaveLength(1);
    expect(Number(before[0].total)).toBe(120);

    await tenantCtx.run(s.tenantId, () =>
      routesService.completeWithPayment(
        s.run.id,
        s.runStop.id,
        {
          deliveries: [
            { orderItemId: s.line1.id, type: "PARTIAL", quantityDelivered: 6 },
            { orderItemId: s.line2.id, type: "REFUSED", quantityDelivered: 0 },
          ],
          payment: { amount: 60, method: "CASH" },
        } as never,
        { sub: "b663-operator", role: "OPERATOR" } as never,
      ),
    );

    const invoices = await prisma.invoice.findMany({
      where: { orderId: s.order.id, status: { not: "VOID" } },
      include: { items: true },
    });
    const billedQty = (orderItemId: string) =>
      invoices.flatMap((i) => i.items).find((it) => it.orderItemId === orderItemId)?.qty;

    // Correct on master already: this is the path the on-account completion must match.
    expect({
      invoiceCount: invoices.length,
      line1Qty: Number(billedQty(s.line1.id) ?? 0),
      line2Qty: Number(billedQty(s.line2.id) ?? 0),
      total: invoices.reduce((sum, i) => sum + Number(i.total), 0),
    }).toEqual({ invoiceCount: 1, line1Qty: 6, line2Qty: 0, total: 60 });
  });
});
