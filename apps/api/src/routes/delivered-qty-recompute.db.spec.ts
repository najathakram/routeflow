/**
 * SA-133 (B785) — `OrderItem.deliveredQty` is RECOMPUTED (Σ the line's own qualifying evidence
 * rows), never incremented or overwritten. Real Postgres, because the bug this guards is a
 * cross-transaction, multi-visit interaction: a partial delivery at one stop, a second visit for
 * the remainder at a DIFFERENT stop, then a reopen of one of them — each step commits its own
 * transaction and only their combined effect on the real DeliveryMutation table proves the
 * recompute is correct. A mocked Prisma spec cannot exercise this.
 *
 * Same boilerplate as complete-on-account-short.db.spec.ts (RoutesService + InvoicesService,
 * every other collaborator mocked at the module boundary).
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
import { FeatureConfigService } from "../billing/feature-config.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { EstimatesService } from "../estimates/estimates.service";
import { NumberingService } from "../import/numbering.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
function freshTenantSlug(label: string): string {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-b785-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "delivered-qty-recompute.db.spec.ts",
  );
}

describeDb("SA-133 (B785): deliveredQty recompute across visits and reopen — real Postgres", () => {
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
        { provide: EntitlementsService, useValue: mockEntitlements },
        entitlementAuthorityFromEntitlements, // #2241
        { provide: CommissionEngineService, useValue: mockCommissionEngine },
        // #2101 (on master): InvoicesService's ban check — this harness never sells a restricted line.
        {
          provide: SellingRestrictionsService,
          useValue: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
        },
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

  /** One order, one line (qty 10), and TWO stops on the same run to simulate a redelivery. */
  async function seedOrderWithTwoStops(label: string) {
    const slug = freshTenantSlug(label);
    const tenant = await prisma.tenant.create({ data: { slug, name: `B785 ${slug}` } });
    createdTenantIds.push(tenant.id);
    const tenantId = tenant.id;
    const idBase = `${tenantId}-${label}`;
    const user = await prisma.user.create({
      data: { email: `${idBase}@example.invalid`, username: idBase, role: "CUSTOMER", tenantId },
    });
    const customer = await prisma.customer.create({
      data: {
        userId: user.id,
        businessName: `B785 customer ${label}`,
        contactName: `B785 contact ${label}`,
        tenantId,
      },
    });
    const product = await prisma.product.create({
      data: { name: `B785 P1 ${label}`, unit: "each", pricePerUnit: 10, tenantId },
    });
    const route = await prisma.route.create({ data: { name: `B785 route ${label}`, tenantId } });
    const routeStopA = await prisma.routeStop.create({
      data: { routeId: route.id, customerId: customer.id, stopNumber: 1, tenantId },
    });
    const routeStopB = await prisma.routeStop.create({
      data: { routeId: route.id, customerId: customer.id, stopNumber: 2, tenantId },
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
    const stopA = await prisma.routeRunStop.create({
      data: {
        routeRunId: run.id,
        routeStopId: routeStopA.id,
        customerId: customer.id,
        stopNumber: 1,
        status: "IN_PROGRESS",
        tenantId,
      },
    });
    const stopB = await prisma.routeRunStop.create({
      data: {
        routeRunId: run.id,
        routeStopId: routeStopB.id,
        customerId: customer.id,
        stopNumber: 2,
        status: "IN_PROGRESS",
        tenantId,
      },
    });
    const order = await prisma.order.create({
      data: {
        customerId: customer.id,
        status: "OUT_FOR_DELIVERY",
        orderNumber: `B785-${RUN_SUFFIX}-${label}`,
        routeRunId: run.id,
        routeRunStopId: stopA.id,
        subtotal: 100,
        tax: 0,
        total: 100,
        tenantId,
      },
    });
    const line = await prisma.orderItem.create({
      data: {
        orderId: order.id,
        productId: product.id,
        qty: 10,
        unitPrice: 10,
        subtotal: 100,
        tenantId,
      },
    });
    await tenantCtx.run(tenantId, () => invoicesService.createInvoiceFromOrder(order.id));
    return { tenantId, order, run, stopA, stopB, line };
  }

  it("a redelivery at a DIFFERENT stop accumulates onto deliveredQty — never overwrites the first visit", async () => {
    const s = await seedOrderWithTwoStops("accum");

    // Visit 1 at stop A: delivers 6 of 10, on account.
    await tenantCtx.run(s.tenantId, () =>
      routesService.completeWithPayment(
        s.run.id,
        s.stopA.id,
        {
          deliveries: [{ orderItemId: s.line.id, type: "PARTIAL", quantityDelivered: 6 }],
        } as never,
        { sub: "b785-operator", role: "OPERATOR" } as never,
      ),
    );
    let refreshed = await prisma.orderItem.findUniqueOrThrow({ where: { id: s.line.id } });
    expect(Number(refreshed.deliveredQty)).toBe(6);

    // Re-point the order at stop B (a redispatch for the remainder) and complete the rest there.
    await prisma.order.update({ where: { id: s.order.id }, data: { routeRunStopId: s.stopB.id } });
    await tenantCtx.run(s.tenantId, () =>
      routesService.completeWithPayment(
        s.run.id,
        s.stopB.id,
        {
          deliveries: [{ orderItemId: s.line.id, type: "DELIVERED", quantityDelivered: 4 }],
        } as never,
        { sub: "b785-operator", role: "OPERATOR" } as never,
      ),
    );

    refreshed = await prisma.orderItem.findUniqueOrThrow({ where: { id: s.line.id } });
    expect(Number(refreshed.deliveredQty)).toBe(10); // 6 + 4, both visits counted
  });

  it("SA-133 (5): reopening ONE stop recomputes deliveredQty down to the OTHER stop's evidence — never zeroes it", async () => {
    const s = await seedOrderWithTwoStops("reopen");

    await tenantCtx.run(s.tenantId, () =>
      routesService.completeWithPayment(
        s.run.id,
        s.stopA.id,
        {
          deliveries: [{ orderItemId: s.line.id, type: "PARTIAL", quantityDelivered: 6 }],
        } as never,
        { sub: "b785-operator", role: "OPERATOR" } as never,
      ),
    );
    await prisma.order.update({ where: { id: s.order.id }, data: { routeRunStopId: s.stopB.id } });
    await tenantCtx.run(s.tenantId, () =>
      routesService.completeWithPayment(
        s.run.id,
        s.stopB.id,
        {
          deliveries: [{ orderItemId: s.line.id, type: "DELIVERED", quantityDelivered: 4 }],
        } as never,
        { sub: "b785-operator", role: "OPERATOR" } as never,
      ),
    );
    let refreshed = await prisma.orderItem.findUniqueOrThrow({ where: { id: s.line.id } });
    expect(Number(refreshed.deliveredQty)).toBe(10);

    // Reopen stop B only — stop A's own 6-unit delivery must survive intact.
    await tenantCtx.run(s.tenantId, () =>
      routesService.reopenStop(s.run.id, s.stopB.id, {
        sub: "b785-operator",
        role: "OPERATOR",
      } as never),
    );

    refreshed = await prisma.orderItem.findUniqueOrThrow({ where: { id: s.line.id } });
    expect(Number(refreshed.deliveredQty)).toBe(6); // stop A's evidence survives; NOT zeroed
    const stopBRows = await prisma.deliveryMutation.findMany({
      where: { orderItemId: s.line.id, routeRunStopId: s.stopB.id },
    });
    expect(stopBRows).toHaveLength(0); // stop B's own rows are genuinely gone
  });

  it("SA-133 (2): the run read's deliveredSoFar for a stop excludes that stop's own rows, but includes the OTHER stop's", async () => {
    const s = await seedOrderWithTwoStops("read");

    await tenantCtx.run(s.tenantId, () =>
      routesService.completeWithPayment(
        s.run.id,
        s.stopA.id,
        {
          deliveries: [{ orderItemId: s.line.id, type: "PARTIAL", quantityDelivered: 6 }],
        } as never,
        { sub: "b785-operator", role: "OPERATOR" } as never,
      ),
    );

    // The order is still linked to stop A at this point — read it BEFORE repointing, so stop A's
    // own orders[] still carries this line. Its own completion must be excluded from its own view.
    const runAfterA: any = await tenantCtx.run(s.tenantId, () =>
      routesService.findOneRun(s.run.id, { sub: "b785-operator", role: "OPERATOR" } as never),
    );
    const stopAOut = runAfterA.stops.find((st: any) => st.id === s.stopA.id);
    const lineOnStopA = stopAOut?.orders
      ?.find((o: any) => o.id === s.order.id)
      ?.lineItems?.find((li: any) => li.id === s.line.id);
    expect(lineOnStopA?.deliveredSoFar).toBe(0);

    // Now redispatch to stop B — its view must see stop A's 6 units as "so far".
    await prisma.order.update({ where: { id: s.order.id }, data: { routeRunStopId: s.stopB.id } });
    const runAfterRepoint: any = await tenantCtx.run(s.tenantId, () =>
      routesService.findOneRun(s.run.id, { sub: "b785-operator", role: "OPERATOR" } as never),
    );
    const stopBOut = runAfterRepoint.stops.find((st: any) => st.id === s.stopB.id);
    const lineOnStopB = stopBOut?.orders
      ?.find((o: any) => o.id === s.order.id)
      ?.lineItems?.find((li: any) => li.id === s.line.id);
    expect(lineOnStopB?.deliveredSoFar).toBe(6);
  });
});
