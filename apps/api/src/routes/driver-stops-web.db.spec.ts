/**
 * SA-1098 PR-2 server rows for the web driver stop: what the SAME `complete-with-payment` request the web screen sends (no `payment`,
 * one explicit entry per line) does on real Postgres (D-4, D-6, D-13, D-16 pin), and the A-2 kept-key rows D-22..D-27 on BOTH completion
 * paths (a key kept across a reopen answers 409 STOP_REOPENED and writes nothing). D-9 (the dropped-response replay) is PR-1's I-1/I-2.
 *
 * SAFETY: throwaway `qa-sa1098-<run>-<n>-<label>` tenants approved by `assertTestTenant`; `afterAll` deletes exactly the tenants
 * this run created, best-effort. Collected only by `jest.db.config.js`.
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
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { IdempotencyService } from "../common/idempotency.service";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { attachInvoicesNeedReview } from "../orders/order-invoices-review";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
function freshTenantSlug(label: string): string {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-sa1098-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "driver-stops-web.db.spec.ts",
  );
}

type Path = "completeStop" | "completeWithPayment";
const PATHS: Path[] = ["completeStop", "completeWithPayment"];
const operator = { sub: "sa1098-operator", role: "OPERATOR" } as never;

describeDb("SA-1098 PR-2 driver stop on the web — real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let routesService: RoutesService;
  let invoicesService: InvoicesService;
  let settleLedger: jest.Mock;
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
  const mockMessaging = {
    notify: jest.fn().mockResolvedValue([]),
    notifyEvent: jest.fn().mockResolvedValue(undefined),
  };
  const mockStorage = {
    upload: jest.fn().mockResolvedValue("stored"),
    presignedUrl: jest.fn().mockResolvedValue("https://signed/url"),
    delete: jest.fn().mockResolvedValue(undefined),
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
        { provide: MessagingService, useValue: mockMessaging },
        { provide: StorageService, useValue: mockStorage },
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

    routesService = module.get(RoutesService);
    invoicesService = module.get(InvoicesService);
    settleLedger = module.get(RegulatedLedgerService).settleRegulatedLedger as jest.Mock;
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

  beforeEach(() => jest.clearAllMocks());

  async function cleanupTenant(tenantId: string): Promise<void> {
    await prisma.regulatedSalesLedger.deleteMany({ where: { tenantId } }); // D-43b's real ledger
    await prisma.auditLog.deleteMany({ where: { tenantId } });
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

  /**
   * A run of `stopCount` stops, each with one two-line order (10 x $10, 4 x $5 = $120) and its DRAFT
   * mirror. The run's last stop is the last of them.
   */
  async function seedRun(label: string, stopCount: number) {
    const slug = freshTenantSlug(label);
    const tenant = await prisma.tenant.create({ data: { slug, name: `SA-1098 ${slug}` } });
    createdTenantIds.push(tenant.id);
    const tenantId = tenant.id;
    const idBase = `${tenantId}-${label}`;
    const route = await prisma.route.create({ data: { name: `SA-1098 ${label}`, tenantId } });
    const run = await prisma.routeRun.create({
      data: {
        routeId: route.id,
        status: "IN_PROGRESS",
        scheduledDate: new Date(),
        startedAt: new Date(),
        tenantId,
      },
    });
    const p1 = await prisma.product.create({
      data: { name: `SA-1098 P1 ${label}`, unit: "each", pricePerUnit: 10, tenantId },
    });
    const p2 = await prisma.product.create({
      data: { name: `SA-1098 P2 ${label}`, unit: "each", pricePerUnit: 5, tenantId },
    });
    const stops: {
      stopId: string;
      orderId: string;
      line1: { id: string };
      line2: { id: string };
    }[] = [];
    for (let n = 1; n <= stopCount; n++) {
      /* eslint-disable no-await-in-loop */
      const user = await prisma.user.create({
        data: {
          email: `${idBase}-${n}@example.invalid`,
          username: `${idBase}-${n}`,
          role: "CUSTOMER",
          tenantId,
        },
      });
      const customer = await prisma.customer.create({
        data: {
          userId: user.id,
          businessName: `SA-1098 customer ${label} ${n}`,
          contactName: `SA-1098 contact ${label} ${n}`,
          tenantId,
        },
      });
      const routeStop = await prisma.routeStop.create({
        data: { routeId: route.id, customerId: customer.id, stopNumber: n, tenantId },
      });
      const runStop = await prisma.routeRunStop.create({
        data: {
          routeRunId: run.id,
          routeStopId: routeStop.id,
          customerId: customer.id,
          stopNumber: n,
          status: "IN_PROGRESS",
          tenantId,
        },
      });
      const order = await prisma.order.create({
        data: {
          customerId: customer.id,
          status: "OUT_FOR_DELIVERY",
          orderNumber: `SA1098-${RUN_SUFFIX}-${label}-${n}`,
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
      await tenantCtx.run(tenantId, () => invoicesService.createInvoiceFromOrder(order.id));
      stops.push({ stopId: runStop.id, orderId: order.id, line1, line2 });
      /* eslint-enable no-await-in-loop */
    }
    return { tenantId, runId: run.id, stops };
  }

  type Seed = Awaited<ReturnType<typeof seedRun>>;
  type Stop = Seed["stops"][number];

  const body = (st: Stop, q1 = 10) => ({
    deliveries: [
      {
        orderItemId: st.line1.id,
        type: q1 === 10 ? "DELIVERED" : "PARTIAL",
        quantityDelivered: q1,
      },
      { orderItemId: st.line2.id, type: "DELIVERED", quantityDelivered: 4 },
    ],
  });

  const complete = (s: Seed, st: Stop, path: Path, dto: unknown, user: never = operator) =>
    tenantCtx.run(s.tenantId, () =>
      routesService[path](s.runId, st.stopId, dto as never, user),
    ) as Promise<unknown>;

  /** Every row a completion writes for this stop, so a test can say none of it moved. */
  async function footprint(s: Seed, st: Stop) {
    const lines = await prisma.orderItem.findMany({
      where: { orderId: st.orderId },
      orderBy: { id: "asc" },
      select: { deliveredQty: true },
    });
    const invoice = await prisma.invoice.findFirst({
      where: { orderId: st.orderId, status: { not: "VOID" } },
      select: { total: true },
    });
    return {
      stop: (await prisma.routeRunStop.findUnique({ where: { id: st.stopId } }))?.status,
      mutations: await prisma.deliveryMutation.count({
        where: { tenantId: s.tenantId, orderItem: { orderId: st.orderId } },
      }),
      payments: await prisma.invoicePayment.count({
        where: { invoice: { orderId: st.orderId } },
      }),
      delivered: lines.map((l) => Number(l.deliveredQty ?? 0)),
      invoiceTotal: Number(invoice?.total ?? -1),
    };
  }

  const web = (st: Stop, q1: number, q2 = 4) => ({
    deliveries: [
      {
        orderItemId: st.line1.id,
        type: q1 <= 0 ? "REFUSED" : q1 === 10 ? "DELIVERED" : "PARTIAL",
        quantityDelivered: q1,
      },
      {
        orderItemId: st.line2.id,
        type: q2 <= 0 ? "REFUSED" : q2 === 4 ? "DELIVERED" : "PARTIAL",
        quantityDelivered: q2,
      },
    ],
  });
  const driverComplete = (s: Seed, st: Stop, dto: unknown, key?: string) =>
    complete(s, st, "completeWithPayment", { ...(dto as object), idempotencyKey: key } as never);

  it("D-4: the web's short delivery (10 -> 7, no payment) completes the stop PARTIAL and bills the delivered goods", async () => {
    const s = await seedRun("d4", 2);
    const st = s.stops[0];
    await driverComplete(s, st, web(st, 7), "k-d4");
    const f = await footprint(s, st);
    expect(f.stop).toBe("COMPLETED");
    expect([...f.delivered].sort()).toEqual([4, 7]); // line 1 short at 7, line 2 in full
    expect(f.mutations).toBe(2);
    expect(f.payments).toBe(0);
    // 7 x 10 + 4 x 5: the invoice follows what was delivered
    expect(f.invoiceTotal).toBe(90);
  });

  it("D-4b: an invoice already SENT is left alone by a short delivery (the shortfall goes to a credit path, not a rewrite)", async () => {
    const s = await seedRun("d4b", 2);
    const st = s.stops[0];
    await prisma.invoice.updateMany({
      where: { orderId: st.orderId },
      data: { status: "SENT" },
    });
    await driverComplete(s, st, web(st, 7), "k-d4b");
    const invoices = await prisma.invoice.findMany({
      where: { orderId: st.orderId, status: { not: "VOID" } },
      select: { status: true, total: true },
    });
    const sent = invoices.filter((i) => i.status === "SENT");
    expect(sent.map((i) => Number(i.total))).toEqual([120]);
  });

  it("D-6: a later visit: 3 of 10 delivered at another stop leaves 7; 8 is refused as not fitting and 7 completes", async () => {
    const s = await seedRun("d6", 2);
    const first = s.stops[0];
    const later = s.stops[1];
    await driverComplete(s, first, web(first, 3), "k-d6a");
    // the undelivered rest of the order rides the next stop (a re-delivery visit)
    await prisma.order.update({
      where: { id: first.orderId },
      data: { routeRunStopId: later.stopId, status: "OUT_FOR_DELIVERY" },
    });
    const dto = (q1: number) => ({
      deliveries: [
        {
          orderItemId: first.line1.id,
          type: q1 === 7 ? "DELIVERED" : "PARTIAL",
          quantityDelivered: q1,
        },
      ],
    });

    const refused = await complete(s, later, "completeWithPayment", dto(8) as never).then(
      () => "accepted",
      (e: { status?: number }) => `refused ${e.status}`,
    );
    // eslint-disable-next-line no-console
    console.info("D-6 observed: 8 of 7 left ->", refused);
    expect(refused).toBe("refused 400");
    await complete(s, later, "completeWithPayment", dto(7) as never);
    const lines = await prisma.orderItem.findFirst({ where: { id: first.line1.id } });
    expect(Number(lines?.deliveredQty ?? 0)).toBe(10);
  });

  it("D-16 (pin): a REFUSED line never bills, whichever answer the server gives", async () => {
    const s = await seedRun("d16", 2);
    const st = s.stops[0];
    const dto = {
      deliveries: [
        { orderItemId: st.line1.id, type: "REFUSED", quantityDelivered: 5 },
        { orderItemId: st.line2.id, type: "DELIVERED", quantityDelivered: 4 },
      ],
    };
    const outcome = await driverComplete(s, st, dto, "k-d16").then(
      () => "accepted",
      (e: { status?: number }) => `refused ${e.status}`,
    );
    const f = await footprint(s, st);
    // eslint-disable-next-line no-console
    console.info("D-16 observed:", outcome, JSON.stringify(f));
    expect(["accepted", "refused 400"]).toContain(outcome);
    if (outcome === "accepted") {
      // line 1 (the refused one) delivered 0 and bills 0: the invoice is line 2 alone, 4 x $5
      expect(f.delivered).toContain(4);
      expect(f.delivered.filter((q) => q > 0)).toEqual([4]);
      expect(f.invoiceTotal).toBe(20);
    } else {
      // a refusal writes nothing
      expect(f).toEqual({
        stop: "IN_PROGRESS",
        mutations: 0,
        payments: 0,
        delivered: [0, 0],
        invoiceTotal: 120,
      });
    }
  });

  it("D-13: Undo on the last stop of a run that finished itself gives run IN_PROGRESS, stop PENDING", async () => {
    const s = await seedRun("d13", 1);
    const st = s.stops[0];
    await driverComplete(s, st, web(st, 10), "k-d13");
    expect((await prisma.routeRun.findUnique({ where: { id: s.runId } }))?.status).toBe(
      "COMPLETED",
    );

    await tenantCtx.run(s.tenantId, () => routesService.reopenStop(s.runId, st.stopId, operator));

    const run = await prisma.routeRun.findUnique({ where: { id: s.runId } });
    const stop = await prisma.routeRunStop.findUnique({ where: { id: st.stopId } });
    expect(run?.status).toBe("IN_PROGRESS");
    expect(stop?.status).toBe("PENDING");
  });

  /**
   * SA-1098 A-3 (D-34..D-44): a line refused (or short), undone, then delivered must bill. The rebuild forgets a line delivered at 0
   * (it leaves the draft), so the next completion has to put an unbilled live line back on a draft before it rebuilds.
   */
  describe("A-3 refused, Undo, delivered bills", () => {
    const undo = (s: Seed, st: Stop) =>
      tenantCtx.run(s.tenantId, () => routesService.reopenStop(s.runId, st.stopId, operator));
    const shapeOf = async (orderId: string) => {
      const invoices = await prisma.invoice.findMany({
        where: { orderId, status: { not: "VOID" } },
        orderBy: { createdAt: "asc" },
        select: { total: true, items: { select: { orderItemId: true, qty: true } } },
      });
      return {
        totals: invoices.map((i) => Number(i.total)),
        items: invoices.map((i) => i.items.length),
      };
    };
    const full = (st: Stop) => web(st, 10, 4);
    const refusedAll = (st: Stop) => web(st, 0, 0);
    const needsReviewRows = (s: { tenantId: string }, orderId: string) =>
      prisma.auditLog.count({
        where: {
          tenantId: s.tenantId,
          action: API_ERROR_CODES.ORDER_INVOICES_NEED_REVIEW,
          entityId: orderId,
        },
      });

    it("D-34: both lines refused, Undo, Delivered in full: 2 items, $120", async () => {
      const s = await seedRun("d34", 2);
      const st = s.stops[0];
      await driverComplete(s, st, refusedAll(st), "k-d34a");
      await undo(s, st);
      await driverComplete(s, st, full(st), "k-d34b");
      expect(await shapeOf(st.orderId)).toEqual({ totals: [120], items: [2] });
    });

    it("D-35: both lines refused, Undo, short at 7: $90", async () => {
      const s = await seedRun("d35", 2);
      const st = s.stops[0];
      await driverComplete(s, st, refusedAll(st), "k-d35a");
      await undo(s, st);
      await driverComplete(s, st, web(st, 7), "k-d35b");
      expect((await shapeOf(st.orderId)).totals).toEqual([90]);
    });

    it.each([
      ["line 1 refused", 0, 4],
      ["line 2 refused", 10, 0],
    ])("D-36: %s, the other in full, Undo, Delivered in full: $120", async (_n, q1, q2) => {
      const s = await seedRun(`d36-${q1}`, 2);
      const st = s.stops[0];
      await driverComplete(s, st, web(st, q1, q2), "k-d36a");
      await undo(s, st);
      await driverComplete(s, st, full(st), "k-d36b");
      expect((await shapeOf(st.orderId)).totals).toEqual([120]);
    });

    it.each([
      ["short, Undo, full", (st: Stop) => web(st, 7), full, 120],
      ["full, Undo, short", full, (st: Stop) => web(st, 7), 90],
      ["refused, Undo, refused", refusedAll, refusedAll, 0],
    ])("D-37 (guard): %s", async (name, first, second, expected) => {
      const s = await seedRun(`d37-${name.slice(0, 5)}`, 2);
      const st = s.stops[0];
      await driverComplete(s, st, first(st), "k-d37a");
      await undo(s, st);
      await driverComplete(s, st, second(st), "k-d37b");
      expect((await shapeOf(st.orderId)).totals).toEqual([expected]);
    });

    it("D-39 (guard): a line refused, Undo, refused again stays off its draft (placed, then dropped by the zero filter); the other bills", async () => {
      const s = await seedRun("d39", 2);
      const st = s.stops[0];
      await driverComplete(s, st, web(st, 0, 4), "k-d39a");
      await undo(s, st);
      await driverComplete(s, st, web(st, 0, 4), "k-d39b");
      expect(await shapeOf(st.orderId)).toEqual({ totals: [20], items: [1] });
    });

    /** Two non-draft/draft arrangements the partition check refuses: nothing is placed, nothing is billed twice. */
    describe("D-38 (guard): the partition check bails", () => {
      const extraInvoice = async (s: Seed, st: Stop, status: "SENT" | "DRAFT", lineId: string) => {
        const order = await prisma.order.findUniqueOrThrow({ where: { id: st.orderId } });
        const inv = await prisma.invoice.create({
          data: {
            tenantId: s.tenantId,
            customerId: order.customerId,
            orderId: st.orderId,
            invoiceNumber: `INV-A3-${RUN_SUFFIX}-${status}-${lineId.slice(0, 6)}`,
            status,
            subtotal: 100,
            taxAmount: 0,
            total: 100,
          },
        });
        await prisma.invoiceItem.create({
          data: {
            tenantId: s.tenantId,
            invoiceId: inv.id,
            orderItemId: lineId,
            description: "line 1",
            qty: 10,
            unitPrice: 10,
            subtotal: 100,
          },
        });
      };
      it.each(["SENT", "DRAFT"] as const)(
        "a line 1 billed by a second %s invoice: the mirror is left as it was",
        async (status) => {
          const s = await seedRun(`d38-${status}`, 2);
          const st = s.stops[0];
          await extraInvoice(s, st, status, st.line1.id);
          const before = await shapeOf(st.orderId);
          await driverComplete(s, st, web(st, 7), `k-d38-${status}`);
          const after = await shapeOf(st.orderId);
          expect(after.items).toEqual(before.items);
          expect(after.totals).toEqual(before.totals);
        },
      );
    });

    /**
     * A split order: `cats` are SEPARATE_INVOICE categories; each line has a category index (null = standard) and a quantity at
     * $10; `drafts` lists which line indexes each draft (base, -R1, ...) holds, in creation order.
     */
    async function seedSplit(
      label: string,
      cats: string[],
      lines: Array<{ cat: number | null; qty: number }>,
      drafts: number[][],
    ) {
      const slug = freshTenantSlug(label);
      const tenant = await prisma.tenant.create({ data: { slug, name: `SA-1098 ${slug}` } });
      createdTenantIds.push(tenant.id);
      const tenantId = tenant.id;
      const route = await prisma.route.create({ data: { name: `SA-1098 ${label}`, tenantId } });
      const run = await prisma.routeRun.create({
        data: {
          routeId: route.id,
          status: "IN_PROGRESS",
          scheduledDate: new Date(),
          startedAt: new Date(),
          tenantId,
        },
      });
      const user = await prisma.user.create({
        data: {
          email: `${tenantId}-${label}@example.invalid`,
          username: `${tenantId}-${label}`,
          role: "CUSTOMER",
          tenantId,
        },
      });
      const customer = await prisma.customer.create({
        data: { userId: user.id, businessName: `SA-1098 ${label}`, contactName: label, tenantId },
      });
      const mkStop = async (n: number) => {
        const rs = await prisma.routeStop.create({
          data: { routeId: route.id, customerId: customer.id, stopNumber: n, tenantId },
        });
        return prisma.routeRunStop.create({
          data: {
            routeRunId: run.id,
            routeStopId: rs.id,
            customerId: customer.id,
            stopNumber: n,
            status: "IN_PROGRESS",
            tenantId,
          },
        });
      };
      const runStop = await mkStop(1);
      await mkStop(2); // keeps the run open
      const categories: Array<{ id: string }> = [];
      for (const [i, name] of cats.entries()) {
        // eslint-disable-next-line no-await-in-loop
        categories.push(
          await prisma.trackedCategory.create({
            data: { tenantId, name: `${name}-${i}`, invoiceTreatment: "SEPARATE_INVOICE" },
          }),
        );
      }
      const subtotal = lines.reduce((sum, l) => sum + l.qty * 10, 0);
      const order = await prisma.order.create({
        data: {
          customerId: customer.id,
          status: "OUT_FOR_DELIVERY",
          orderNumber: `SA1098-${RUN_SUFFIX}-${label}`,
          routeRunId: run.id,
          routeRunStopId: runStop.id,
          subtotal,
          tax: 0,
          total: subtotal,
          tenantId,
        },
      });
      const made: Array<{ id: string; productId: string; catId: string | null }> = [];
      for (const [i, l] of lines.entries()) {
        const catId = l.cat === null ? null : categories[l.cat].id;
        // eslint-disable-next-line no-await-in-loop
        const product = await prisma.product.create({
          data: {
            name: `SA-1098 ${label} p${i}`,
            unit: "each",
            pricePerUnit: 10,
            tenantId,
            ...(catId ? { trackedCategoryId: catId } : {}),
          },
        });
        // eslint-disable-next-line no-await-in-loop
        const li = await prisma.orderItem.create({
          data: {
            orderId: order.id,
            productId: product.id,
            qty: l.qty,
            unitPrice: 10,
            subtotal: l.qty * 10,
            tenantId,
            ...(catId ? { trackedCategoryId: catId } : {}),
          },
        });
        made.push({ id: li.id, productId: product.id, catId });
      }
      const groupId = randomUUID();
      const invoiceIds: string[] = [];
      for (const [d, idxs] of drafts.entries()) {
        const sub = idxs.reduce((sum, i) => sum + lines[i].qty * 10, 0);
        // eslint-disable-next-line no-await-in-loop
        const inv = await prisma.invoice.create({
          data: {
            tenantId,
            customerId: customer.id,
            orderId: order.id,
            invoiceGroupId: groupId,
            invoiceNumber: `INV-A3-${RUN_SUFFIX}-${label}${d === 0 ? "" : `-R${d}`}`,
            status: "DRAFT",
            subtotal: sub,
            taxAmount: 0,
            total: sub,
          },
        });
        invoiceIds.push(inv.id);
        for (const i of idxs) {
          // eslint-disable-next-line no-await-in-loop
          await prisma.invoiceItem.create({
            data: {
              tenantId,
              invoiceId: inv.id,
              orderItemId: made[i].id,
              productId: made[i].productId,
              description: `p${i}`,
              qty: lines[i].qty,
              unitPrice: 10,
              subtotal: lines[i].qty * 10,
              ...(made[i].catId ? { trackedCategoryId: made[i].catId } : {}),
            },
          });
        }
      }
      return { tenantId, runId: run.id, stopId: runStop.id, orderId: order.id, made, invoiceIds };
    }
    type Split = Awaited<ReturnType<typeof seedSplit>>;
    const splitDto = (sp: Split, qtys: number[], ordered: number[]) => ({
      deliveries: sp.made.map((l, i) => ({
        orderItemId: l.id,
        type: qtys[i] <= 0 ? "REFUSED" : qtys[i] === ordered[i] ? "DELIVERED" : "PARTIAL",
        quantityDelivered: qtys[i],
      })),
    });
    const splitGo = (sp: Split, dto: unknown, key: string) =>
      tenantCtx.run(sp.tenantId, () =>
        routesService.completeWithPayment(
          sp.runId,
          sp.stopId,
          { ...(dto as object), idempotencyKey: key } as never,
          operator,
        ),
      );
    const splitUndo = (sp: Split) =>
      tenantCtx.run(sp.tenantId, () => routesService.reopenStop(sp.runId, sp.stopId, operator));
    /** Per draft, in creation order: the order-line indexes it bills and its total. */
    const splitState = async (sp: Split) => {
      const invoices = await prisma.invoice.findMany({
        where: { orderId: sp.orderId, status: { not: "VOID" } },
        orderBy: { createdAt: "asc" },
        select: { total: true, items: { select: { orderItemId: true } } },
      });
      return invoices.map((i) => ({
        total: Number(i.total),
        lines: i.items
          .map((it) => sp.made.findIndex((m) => m.id === it.orderItemId))
          .sort((a, b) => a - b),
      }));
    };

    it("D-40: a split order, base and -R1, everything refused, Undo, Delivered: each line on its own draft, none folded", async () => {
      const sp = await seedSplit(
        "d40",
        ["R"],
        [
          { cat: null, qty: 1 },
          { cat: 0, qty: 3 },
        ],
        [[0], [1]],
      );
      await splitGo(sp, splitDto(sp, [0, 0], [1, 3]), "k-d40a");
      await splitUndo(sp);
      await splitGo(sp, splitDto(sp, [1, 3], [1, 3]), "k-d40b");
      expect(await splitState(sp)).toEqual([
        { total: 10, lines: [0] },
        { total: 30, lines: [1] },
      ]);
    });

    it("D-41 (guard): lines whose groups don't match the drafts are left off, with a needs-review row; the stop completes", async () => {
      // three groups (standard, R, S) but two drafts: the S line is on no draft and cannot be placed
      const sp = await seedSplit(
        "d41",
        ["R", "S"],
        [
          { cat: null, qty: 1 },
          { cat: 0, qty: 3 },
          { cat: 1, qty: 2 },
        ],
        [[0], [1]],
      );
      await splitGo(sp, splitDto(sp, [1, 3, 2], [1, 3, 2]), "k-d41");
      expect(await splitState(sp)).toEqual([
        { total: 10, lines: [0] },
        { total: 30, lines: [1] },
      ]);
      expect((await prisma.routeRunStop.findUnique({ where: { id: sp.stopId } }))?.status).toBe(
        "COMPLETED",
      );
      expect(await needsReviewRows(sp, sp.orderId)).toBe(1);
    });

    it("D-42 (record): a lone office partial on line 1, everything delivered: the total is what was delivered, no double", async () => {
      const s = await seedRun("d42", 2);
      const st = s.stops[0];
      await prisma.invoiceItem.deleteMany({
        where: { orderItemId: st.line2.id },
      });
      await prisma.invoice.updateMany({
        where: { orderId: st.orderId },
        data: { subtotal: 100, total: 100 },
      });
      await driverComplete(s, st, full(st), "k-d42");
      const shape = await shapeOf(st.orderId);
      // eslint-disable-next-line no-console
      console.info("D-42 observed:", JSON.stringify(shape));
      expect(shape).toEqual({ totals: [120], items: [2] });
    });

    it("D-43 (guard): a regulated line refused, Undo, Delivered: the ledger is settled once, at the delivered quantity", async () => {
      const sp = await seedSplit("d43", ["R"], [{ cat: 0, qty: 3 }], [[0]]);
      await splitGo(sp, splitDto(sp, [0], [3]), "k-d43a");
      await splitUndo(sp);
      settleLedger.mockClear();
      await splitGo(sp, splitDto(sp, [3], [3]), "k-d43b");
      const calls = settleLedger.mock.calls.map((c) => c[1] as { lines: Array<{ qty: number }> });
      expect(calls.at(-1)?.lines.map((l) => l.qty)).toEqual([3]);
    });

    it("D-43b (guard): the same entry through the REAL ledger: the line's rows net to the delivered quantity, once", async () => {
      const real = new RegulatedLedgerService(prisma);
      settleLedger.mockImplementation((db: unknown, event: never) =>
        real.settleRegulatedLedger(db, event),
      );
      try {
        const sp = await seedSplit("d43r", ["R"], [{ cat: 0, qty: 3 }], [[0]]);
        const rowsFor = () =>
          prisma.regulatedSalesLedger.findMany({
            where: { orderItemId: sp.made[0].id },
            orderBy: { createdAt: "asc" },
            select: { entryType: true, qty: true, unitBasisQty: true, netSales: true },
          });
        await splitGo(sp, splitDto(sp, [0], [3]), "k-d43ra");
        const afterRefused = (await rowsFor()).map((r) => `${r.entryType}:${Number(r.qty)}`);
        await splitUndo(sp);
        const afterUndo = (await rowsFor()).map((r) => `${r.entryType}:${Number(r.qty)}`);
        await splitGo(sp, splitDto(sp, [3], [3]), "k-d43rb");
        const rows = await rowsFor();
        // eslint-disable-next-line no-console
        console.info(
          "D-43b observed:",
          JSON.stringify({
            afterRefused,
            afterUndo,
            final: rows.map((r) => `${r.entryType}:${Number(r.qty)}`),
          }),
        );
        const net = rows.reduce((sum, r) => sum + Number(r.qty), 0);
        expect(net).toBe(3);
        expect(rows.filter((r) => r.entryType === "SALE" && Number(r.qty) > 0)).toHaveLength(1);
      } finally {
        settleLedger.mockReset();
        settleLedger.mockResolvedValue({ written: 0, amendedPeriod: null });
      }
    });

    /** What the office's order read stamps on the order (the staff attach `orders.service.findOne` calls). */
    const officeReads = (sp: { tenantId: string; orderId: string }) =>
      tenantCtx.run(sp.tenantId, async () => {
        const order: { id: string; tenantId: string; invoicesNeedReview?: unknown } = {
          id: sp.orderId,
          tenantId: sp.tenantId,
        };
        await attachInvoicesNeedReview(prisma.forTenant() as never, order, { role: "OPERATOR" });
        return order.invoicesNeedReview;
      });
    const LEFT_OFF_REASON =
      "A delivered line on this order isn't on any invoice. Create an invoice for it.";
    /** D-41's arrangement: the S line (index 2) is on no draft and cannot be placed. */
    const seedLeftOff = async (label: string) => {
      const sp = await seedSplit(
        label,
        ["R", "S"],
        [
          { cat: null, qty: 1 },
          { cat: 0, qty: 3 },
          { cat: 1, qty: 2 },
        ],
        [[0], [1]],
      );
      await splitGo(sp, splitDto(sp, [1, 3, 2], [1, 3, 2]), `k-${label}`);
      return sp;
    };

    it("D-41b (red): after D-41 the office's order read flags the line left off, with the reason", async () => {
      const sp = await seedLeftOff("d41b");
      expect(await officeReads(sp)).toEqual({ flagged: true, reason: LEFT_OFF_REASON });
    });

    it("D-41c (guard): the office creates an invoice for that line: not refused, the line bills, the flag clears", async () => {
      const sp = await seedLeftOff("d41c");
      expect(await officeReads(sp)).toMatchObject({ flagged: true });
      await tenantCtx.run(sp.tenantId, () =>
        invoicesService.createPartialFromOrder(sp.orderId, {
          items: [{ orderItemId: sp.made[2].id, qty: 2 }],
        } as never),
      );
      const billed = await prisma.invoiceItem.findMany({
        where: { orderItemId: sp.made[2].id, invoice: { status: { not: "VOID" } } },
        select: { qty: true },
      });
      expect(billed.map((b) => Number(b.qty))).toEqual([2]);
      expect(await officeReads(sp)).toEqual({ flagged: false });
    });

    it("D-41d (guard): an office partial's remainder, delivered, with no left-off audit row is not flagged", async () => {
      const s = await seedRun("d41d", 2);
      const st = s.stops[0];
      // an office partial on line 1 only; line 2 delivered and on no invoice, but nothing left it off
      await prisma.invoiceItem.deleteMany({ where: { orderItemId: st.line2.id } });
      await prisma.invoice.updateMany({
        where: { orderId: st.orderId },
        data: { subtotal: 100, total: 100 },
      });
      await prisma.orderItem.update({
        where: { id: st.line2.id },
        data: { invoicedQty: 0, deliveredQty: 4 },
      });
      expect(await needsReviewRows(s, st.orderId)).toBe(0);
      expect(await officeReads({ tenantId: s.tenantId, orderId: st.orderId })).toEqual({
        flagged: false,
      });
    });

    it("D-44 (record): between Undo and the next completion the draft keeps the last numbers", async () => {
      const s = await seedRun("d44", 2);
      const st = s.stops[0];
      await driverComplete(s, st, web(st, 7), "k-d44a");
      await undo(s, st);
      const shape = await shapeOf(st.orderId);
      // eslint-disable-next-line no-console
      console.info("D-44 observed:", JSON.stringify(shape));
      expect(shape.totals).toEqual([90]);
    });
  });

  /** SA-1098 A-2: a kept key after a reopen. Both completion paths share `replayStopKey`, so every row runs on both. */
  describe.each(PATHS)("A-2 kept key, %s", (path) => {
    const attempt = (p: Promise<unknown>) =>
      p.then(
        () => ({ ok: true as const, status: 200, code: undefined as string | undefined }),
        (e: {
          getStatus?: () => number;
          status?: number;
          getResponse?: () => { code?: string };
          response?: { code?: string };
        }) => ({
          ok: false as const,
          status: e.getStatus?.() ?? e.status ?? 0,
          code: (e.getResponse?.() ?? e.response)?.code,
        }),
      );
    const reopen = (s: Seed, st: Stop) =>
      tenantCtx.run(s.tenantId, () => routesService.reopenStop(s.runId, st.stopId, operator));
    const go = (s: Seed, st: Stop, dto: object, key: string) =>
      attempt(complete(s, st, path, { ...dto, idempotencyKey: key }));

    it("D-22: complete with K, reopen, K again with the same body: 409 STOP_REOPENED, stop PENDING, nothing written", async () => {
      const s = await seedRun(`d22-${path.slice(8, 12)}`, 2);
      const st = s.stops[0];
      await go(s, st, body(st), "k-d22");
      await reopen(s, st);
      const reopened = await footprint(s, st);
      expect(reopened.stop).toBe("PENDING");

      const again = await go(s, st, body(st), "k-d22");

      expect(again).toMatchObject({ ok: false, status: 409, code: "STOP_REOPENED" });
      expect(await footprint(s, st)).toEqual(reopened);
      expect(reopened.mutations).toBe(0);
    });

    it("D-23: the same, with a changed quantity: still 409 STOP_REOPENED (the status read comes before the hash check)", async () => {
      const s = await seedRun(`d23-${path.slice(8, 12)}`, 2);
      const st = s.stops[0];
      await go(s, st, body(st), "k-d23");
      await reopen(s, st);
      const reopened = await footprint(s, st);

      const again = await go(s, st, body(st, 7), "k-d23");

      expect(again).toMatchObject({ ok: false, status: 409, code: "STOP_REOPENED" });
      expect(await footprint(s, st)).toEqual(reopened);
    });

    it("D-24: after a reopen, a NEW key completes the stop correctly", async () => {
      const s = await seedRun(`d24-${path.slice(8, 12)}`, 2);
      const st = s.stops[0];
      await go(s, st, body(st), "k-d24");
      await reopen(s, st);

      const again = await go(s, st, body(st, 7), "k-d24-new");

      expect(again.ok).toBe(true);
      const f = await footprint(s, st);
      expect(f.stop).toBe("COMPLETED");
      expect([...f.delivered].sort()).toEqual([4, 7]);
      expect(f.mutations).toBe(2);
    });

    it.each([2, 1])(
      "D-25: a lost response, K again while the stop is still COMPLETED, replays with one set of rows (%i stops)",
      async (stopCount) => {
        const s = await seedRun(`d25-${stopCount}-${path.slice(8, 12)}`, stopCount);
        const st = s.stops[stopCount - 1]; // the last stop: the run finishes itself when it is the only open one
        for (const earlier of s.stops.slice(0, -1)) {
          // eslint-disable-next-line no-await-in-loop
          await go(s, earlier, body(earlier), `k-d25-${earlier.stopId}`);
        }
        await go(s, st, body(st), "k-d25");
        const done = await footprint(s, st);

        const again = await go(s, st, body(st), "k-d25");

        expect(again.ok).toBe(true);
        expect(await footprint(s, st)).toEqual(done);
        expect(done.mutations).toBe(2);
      },
    );

    it("D-26: reopened, completed with K2, then K: replays with no new rows; a changed quantity gets the existing conflict", async () => {
      const s = await seedRun(`d26-${path.slice(8, 12)}`, 2);
      const st = s.stops[0];
      await go(s, st, body(st), "k-d26");
      await reopen(s, st);
      await go(s, st, body(st), "k-d26-2");
      const done = await footprint(s, st);

      const replay = await go(s, st, body(st), "k-d26");
      expect(replay.ok).toBe(true);
      expect(await footprint(s, st)).toEqual(done);

      const changed = await go(s, st, body(st, 7), "k-d26");
      expect(changed).toMatchObject({ ok: false, status: 409, code: "IDEMPOTENCY_KEY_CONFLICT" });
      expect(await footprint(s, st)).toEqual(done);
    });

    it("D-27: two at once with the same key, repeated: 200 or STOP_ALREADY_COMPLETED, never STOP_REOPENED", async () => {
      const s = await seedRun(`d27-${path.slice(8, 12)}`, 4);
      for (const st of s.stops) {
        // eslint-disable-next-line no-await-in-loop
        const [a, b] = await Promise.all([
          go(s, st, body(st), `k-d27-${st.stopId}`),
          go(s, st, body(st), `k-d27-${st.stopId}`),
        ]);
        for (const r of [a, b]) {
          if (!r.ok) expect(r.code).toBe("STOP_ALREADY_COMPLETED");
        }
        expect([a, b].some((r) => r.ok)).toBe(true);
        // eslint-disable-next-line no-await-in-loop
        const f = await footprint(s, st);
        expect(f.stop).toBe("COMPLETED");
        expect(f.mutations).toBe(2);
      }
    });
  });
});
