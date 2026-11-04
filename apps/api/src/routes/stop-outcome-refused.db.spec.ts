/**
 * SA-1101 (Batch 3): what a stop close makes each order, end to end on real Postgres.
 * RO-1 (refuse every line -> REFUSED, one ORDER_REFUSED, draft invoice $ OBSERVED), RO-2 (mixed stop),
 * RO-3 (short line stays DELIVERED), RO-13 (the bare /complete path), RO-4 (reopen clears deliveredAt),
 * RO-6/6b/6c (B785: every line with something left needs an entry), RO-5/5b (startedAt on complete only),
 * RO-9 (a return on a REFUSED order: stock back, credit OBSERVED).
 *
 * The REAL RoutesService and InvoicesService run; every other collaborator is mocked at the module boundary
 * as complete-on-account-short.db.spec.ts does. Collected only by jest.db.config.js (npm run local:test:db).
 *
 * SAFETY: throwaway qa-sa1101-<run>-<n>-<label> tenants approved by assertTestTenant; afterAll deletes exactly
 * the tenants THIS run created, best-effort.
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
    `qa-sa1101-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "stop-outcome-refused.db.spec.ts",
  );
}

describeDb("SA-1101 refused order — stop close outcomes, real Postgres", () => {
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
            settleRegulatedLedger: jest.fn().mockResolvedValue({ written: 0, amendedPeriod: null }),
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
    await prisma.auditLog.deleteMany({ where: { tenantId } }); // W-769: the over-reserved rows
    await prisma.advancePayment.deleteMany({ where: { tenantId } });
    await prisma.invoicePayment.deleteMany({ where: { invoice: { tenantId } } });
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
  type OrderSpec = { key: string; lines: Array<{ qty: number; price: number }> };

  /** A run stop carrying one OUT_FOR_DELIVERY order per spec, each with its DRAFT pending mirror. */
  async function seedStop(
    label: string,
    specs: OrderSpec[],
    runStatus: "IN_PROGRESS" | "SCHEDULED" = "IN_PROGRESS",
  ) {
    const slug = freshTenantSlug(label);
    const tenant = await prisma.tenant.create({ data: { slug, name: `SA1101 ${slug}` } });
    createdTenantIds.push(tenant.id);
    const tenantId = tenant.id;
    const idBase = `${tenantId}-${label}`;
    const user = await prisma.user.create({
      data: { email: `${idBase}@example.invalid`, username: idBase, role: "CUSTOMER", tenantId },
    });
    const customer = await prisma.customer.create({
      data: {
        userId: user.id,
        businessName: `SA1101 customer ${label}`,
        contactName: `SA1101 contact ${label}`,
        tenantId,
      },
    });
    const route = await prisma.route.create({ data: { name: `SA1101 route ${label}`, tenantId } });
    const routeStop = await prisma.routeStop.create({
      data: { routeId: route.id, customerId: customer.id, stopNumber: 1, tenantId },
    });
    const run = await prisma.routeRun.create({
      data: {
        routeId: route.id,
        status: runStatus,
        scheduledDate: new Date(),
        startedAt: runStatus === "IN_PROGRESS" ? new Date() : null,
        tenantId,
      },
    });
    const runStop = await prisma.routeRunStop.create({
      data: {
        routeRunId: run.id,
        routeStopId: routeStop.id,
        customerId: customer.id,
        stopNumber: 1,
        status: runStatus === "IN_PROGRESS" ? "IN_PROGRESS" : "PENDING",
        tenantId,
      },
    });
    const orders: Record<string, { id: string; lineIds: string[] }> = {};
    for (const spec of specs) {
      const total = spec.lines.reduce((s, l) => s + l.qty * l.price, 0);
      const order = await prisma.order.create({
        data: {
          customerId: customer.id,
          status: "OUT_FOR_DELIVERY",
          orderNumber: `SA1101-${RUN_SUFFIX}-${label}-${spec.key}`,
          routeRunId: run.id,
          routeRunStopId: runStop.id,
          subtotal: total,
          tax: 0,
          total,
          tenantId,
        },
      });
      const lineIds: string[] = [];
      for (const [i, l] of spec.lines.entries()) {
        const product = await prisma.product.create({
          data: {
            name: `SA1101 ${label} ${spec.key}${i}`,
            unit: "each",
            pricePerUnit: l.price,
            tenantId,
          },
        });
        const line = await prisma.orderItem.create({
          data: {
            orderId: order.id,
            productId: product.id,
            qty: l.qty,
            unitPrice: l.price,
            subtotal: l.qty * l.price,
            tenantId,
          },
        });
        lineIds.push(line.id);
      }
      await tenantCtx.run(tenantId, () => invoicesService.createInvoiceFromOrder(order.id));
      orders[spec.key] = { id: order.id, lineIds };
    }
    return { tenantId, run, runStop, orders };
  }

  const OPERATOR = { sub: "sa1101-operator", role: "OPERATOR" } as never;
  const orderRow = (id: string) => prisma.order.findUniqueOrThrow({ where: { id } });
  const liveInvoiceTotal = async (orderId: string) =>
    (await prisma.invoice.findMany({ where: { orderId, status: { not: "VOID" } } })).reduce(
      (sum, i) => sum + Number(i.total),
      0,
    );
  const refuse = (id: string) => ({ orderItemId: id, type: "REFUSED", quantityDelivered: 0 });
  const deliver = (id: string, qty: number) => ({
    orderItemId: id,
    type: qty > 0 ? "DELIVERED" : "REFUSED",
    quantityDelivered: qty,
  });
  const noticeKinds = () => mockMessaging.notifyEvent.mock.calls.map(([event]) => event as string);

  beforeEach(() => mockMessaging.notifyEvent.mockClear());

  it("RO-1: refusing every line closes the order REFUSED, one ORDER_REFUSED, no DELIVERED notice; draft $ observed", async () => {
    const s = await seedStop("ro1", [
      {
        key: "A",
        lines: [
          { qty: 10, price: 10 },
          { qty: 4, price: 5 },
        ],
      },
    ]);
    const [l1, l2] = s.orders.A.lineIds;
    await tenantCtx.run(s.tenantId, () =>
      routesService.completeWithPayment(
        s.run.id,
        s.runStop.id,
        { deliveries: [refuse(l1), refuse(l2)] } as never,
        OPERATOR,
      ),
    );
    const o = await orderRow(s.orders.A.id);
    expect({ status: o.status, deliveredAt: o.deliveredAt }).toEqual({
      status: "REFUSED",
      deliveredAt: null,
    });
    expect(noticeKinds()).toEqual(["ORDER_REFUSED"]);
    expect(mockMessaging.notifyEvent.mock.calls[0][1].vars).toEqual({ orderNumber: o.orderNumber });
    // OBSERVED (SA-1101 §2.2): the refused order's live invoice total. $0 expected; above $0 goes back to the SA.
    const observed = await liveInvoiceTotal(s.orders.A.id);
    console.info(`SA-1101 RO-1 observed refused-order invoice total: $${observed}`);
    expect(observed).toBe(0);
  });

  it("RO-2: a mixed stop - A delivered in full, B refused in full - each gets its own outcome and notice", async () => {
    const s = await seedStop("ro2", [
      { key: "A", lines: [{ qty: 10, price: 10 }] },
      { key: "B", lines: [{ qty: 4, price: 5 }] },
    ]);
    await tenantCtx.run(s.tenantId, () =>
      routesService.completeWithPayment(
        s.run.id,
        s.runStop.id,
        {
          deliveries: [deliver(s.orders.A.lineIds[0], 10), refuse(s.orders.B.lineIds[0])],
        } as never,
        OPERATOR,
      ),
    );
    const a = await orderRow(s.orders.A.id);
    const b = await orderRow(s.orders.B.id);
    const stop = await prisma.routeRunStop.findUniqueOrThrow({ where: { id: s.runStop.id } });
    expect([a.status, b.status]).toEqual(["DELIVERED", "REFUSED"]);
    expect(a.deliveredAt).not.toBeNull();
    expect(stop.completedAt).not.toBeNull();
    expect(b.deliveredAt).toBeNull();
    expect([...noticeKinds()].sort()).toEqual(["DELIVERED", "ORDER_REFUSED"]);

    // RO-4: reopening the stop returns both to CONFIRMED with no delivered date left behind.
    await tenantCtx.run(s.tenantId, () =>
      routesService.reopenStop(s.run.id, s.runStop.id, OPERATOR),
    );
    const [a2, b2] = [await orderRow(s.orders.A.id), await orderRow(s.orders.B.id)];
    expect([a2.status, b2.status]).toEqual(["CONFIRMED", "CONFIRMED"]);
    expect([a2.deliveredAt, b2.deliveredAt]).toEqual([null, null]);
  });

  it("RO-3: a line delivered short (10 -> 7) is DELIVERED with deliveredAt set", async () => {
    const s = await seedStop("ro3", [{ key: "A", lines: [{ qty: 10, price: 10 }] }]);
    await tenantCtx.run(s.tenantId, () =>
      routesService.completeWithPayment(
        s.run.id,
        s.runStop.id,
        {
          deliveries: [
            { orderItemId: s.orders.A.lineIds[0], type: "PARTIAL", quantityDelivered: 7 },
          ],
        } as never,
        OPERATOR,
      ),
    );
    const o = await orderRow(s.orders.A.id);
    expect(o.status).toBe("DELIVERED");
    expect(o.deliveredAt).not.toBeNull();
    expect(noticeKinds()).toEqual(["DELIVERED"]);
  });

  it("RO-13: the bare /complete path closes a fully refused order REFUSED with the same notice", async () => {
    const s = await seedStop("ro13", [{ key: "A", lines: [{ qty: 6, price: 10 }] }]);
    await tenantCtx.run(s.tenantId, () =>
      routesService.completeStop(
        s.run.id,
        s.runStop.id,
        { deliveries: [refuse(s.orders.A.lineIds[0])] } as never,
        OPERATOR,
      ),
    );
    const o = await orderRow(s.orders.A.id);
    expect({ status: o.status, deliveredAt: o.deliveredAt }).toEqual({
      status: "REFUSED",
      deliveredAt: null,
    });
    expect(noticeKinds()).toEqual(["ORDER_REFUSED"]);
  });

  describe("B785: every line with something left needs an entry in deliveries", () => {
    const twoLines = [
      {
        key: "A",
        lines: [
          { qty: 10, price: 10 },
          { qty: 4, price: 5 },
        ],
      },
    ];
    const stopState = async (s: { runStop: { id: string }; tenantId: string }) => ({
      stop: (await prisma.routeRunStop.findUniqueOrThrow({ where: { id: s.runStop.id } })).status,
      mutations: await prisma.deliveryMutation.count({ where: { tenantId: s.tenantId } }),
    });

    it("RO-6: deliveries [] on an order with something left is a 400; the stop stays open, nothing written", async () => {
      const s = await seedStop("ro6", twoLines);
      await expect(
        tenantCtx.run(s.tenantId, () =>
          routesService.completeWithPayment(
            s.run.id,
            s.runStop.id,
            { deliveries: [] } as never,
            OPERATOR,
          ),
        ),
      ).rejects.toMatchObject({ response: { code: "STOP_DELIVERY_LINES_MISSING" } });
      expect(await stopState(s)).toEqual({ stop: "IN_PROGRESS", mutations: 0 });
      expect((await orderRow(s.orders.A.id)).status).toBe("OUT_FOR_DELIVERY");
    });

    it("RO-6b: two lines and an entry for one is a 400 naming one missing", async () => {
      const s = await seedStop("ro6b", twoLines);
      await expect(
        tenantCtx.run(s.tenantId, () =>
          routesService.completeWithPayment(
            s.run.id,
            s.runStop.id,
            { deliveries: [deliver(s.orders.A.lineIds[0], 10)] } as never,
            OPERATOR,
          ),
        ),
      ).rejects.toThrow(/1 line is missing/);
      expect(await stopState(s)).toEqual({ stop: "IN_PROGRESS", mutations: 0 });
    });

    it("RO-6c (guard): naming every line with something left closes the stop as before", async () => {
      const s = await seedStop("ro6c", twoLines);
      const [a, b] = s.orders.A.lineIds;
      await tenantCtx.run(s.tenantId, () =>
        routesService.completeWithPayment(
          s.run.id,
          s.runStop.id,
          { deliveries: [deliver(a, 10), deliver(b, 4)] } as never,
          OPERATOR,
        ),
      );
      expect((await orderRow(s.orders.A.id)).status).toBe("DELIVERED");
    });
  });

  describe("B782: startedAt on start or complete, never on cancel", () => {
    it("RO-5: COMPLETED from SCHEDULED stamps startedAt; RO-5b: CANCELLED from SCHEDULED does not", async () => {
      const done = await seedStop(
        "ro5",
        [{ key: "A", lines: [{ qty: 1, price: 1 }] }],
        "SCHEDULED",
      );
      await prisma.routeRunStop.update({
        where: { id: done.runStop.id },
        data: { status: "SKIPPED" },
      });
      await tenantCtx.run(done.tenantId, () =>
        routesService.updateRunStatus(done.run.id, { status: "COMPLETED" } as never, OPERATOR),
      );
      const completed = await prisma.routeRun.findUniqueOrThrow({ where: { id: done.run.id } });
      expect(completed.startedAt).not.toBeNull();

      const gone = await seedStop(
        "ro5b",
        [{ key: "A", lines: [{ qty: 1, price: 1 }] }],
        "SCHEDULED",
      );
      await tenantCtx.run(gone.tenantId, () =>
        routesService.updateRunStatus(gone.run.id, { status: "CANCELLED" } as never, OPERATOR),
      );
      const cancelled = await prisma.routeRun.findUniqueOrThrow({ where: { id: gone.run.id } });
      expect(cancelled.startedAt).toBeNull();
    });
  });
});
