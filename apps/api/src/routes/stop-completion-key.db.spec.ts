/**
 * SA-1098 PR-1 (SA-953 S1, S2; W-908, W-909; B1034, B870). A phone browser loses responses, so a
 * retry of a stop completion that really did commit must get its first answer back.
 *
 * Rows I-1 to I-4 are SA-1098 §10's. I-1b and I-6 to I-9 pin what the key's move must keep: nothing
 * runs ahead of a refusal, ownership stays first (#2415), the key is per stop, a new key still meets
 * the state check, and two attempts at once still write one set of rows.
 *
 * WHY THE DB LANE: the key's whole claim is that it commits or rolls back with the completion, which
 * only real Postgres can show. Collected only by `jest.db.config.js`. Prisma, RoutesService and
 * InvoicesService are real; everything else is mocked at the module boundary, as in
 * `complete-on-account-short.db.spec.ts`.
 *
 * SAFETY: throwaway `qa-sa1098-<run>-<n>-<label>` tenants approved by `assertTestTenant`; `afterAll`
 * deletes exactly the tenants this run created, best-effort.
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
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
function freshTenantSlug(label: string): string {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-sa1098-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "stop-completion-key.db.spec.ts",
  );
}

type Path = "completeStop" | "completeWithPayment";
const PATHS: Path[] = ["completeStop", "completeWithPayment"];
const operator = { sub: "sa1098-operator", role: "OPERATOR" } as never;

describeDb("SA-1098 PR-1 stop completion key — real Postgres", () => {
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
            getAll: jest.fn().mockResolvedValue({}),
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

  const asWire = (v: unknown) => JSON.parse(JSON.stringify(v));

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

  const keyRows = (s: Seed, st: Stop, path: Path, key: string) =>
    prisma.idempotencyKey.count({
      where: {
        keyHash: new IdempotencyService().hashFor(
          key,
          s.tenantId,
          `${path}:${s.runId}:${st.stopId}`,
        ),
      },
    });

  describe.each(PATHS)("%s", (path) => {
    const withMoney = (st: Stop, q1 = 10, amount = q1 * 10 + 20, method = "CASH") =>
      path === "completeWithPayment"
        ? { ...body(st, q1), payment: { amount, method } }
        : body(st, q1);

    it("I-1 Red. Same key, same body, after commit: the first answer again, and nothing runs twice", async () => {
      const s = await seedRun(`i1-${path}`, 2);
      const st = s.stops[0];
      const dto = { ...withMoney(st), idempotencyKey: `k-${st.stopId}` };
      const first = await complete(s, st, path, dto);
      const before = await footprint(s, st);
      expect(before.mutations).toBe(2); // one per line
      const events = mockGateway.emitStopCompleted.mock.calls.length;
      const notices = mockMessaging.notifyEvent.mock.calls.length;

      const second = await complete(s, st, path, dto);

      expect(asWire(second)).toEqual(asWire(first));
      expect(await footprint(s, st)).toEqual(before);
      expect(mockGateway.emitStopCompleted.mock.calls.length).toBe(events);
      expect(mockMessaging.notifyEvent.mock.calls.length).toBe(notices);
    });

    it("I-1b. The replay stores no new proof photo", async () => {
      const s = await seedRun(`i1b-${path}`, 2);
      const st = s.stops[0];
      const dto = { ...withMoney(st), idempotencyKey: `k-${st.stopId}` };
      await complete(s, st, path, dto);
      mockStorage.upload.mockClear();

      await complete(s, st, path, { ...dto, podPhotoUrls: ["data:image/png;base64,AAAA"] });

      expect(mockStorage.upload).not.toHaveBeenCalled();
    });

    it("I-2 Red. Last stop, same key, after the run completed itself: the first answer again", async () => {
      const s = await seedRun(`i2-${path}`, 1);
      const st = s.stops[0];
      const dto = { ...body(st), idempotencyKey: `k-${st.stopId}` }; // no money: the run closes
      const first = await complete(s, st, path, dto);
      const run = await prisma.routeRun.findUnique({ where: { id: s.runId } });
      expect(run?.status).toBe("COMPLETED");
      const before = await footprint(s, st);

      const second = await complete(s, st, path, dto);

      expect(asWire(second)).toEqual(asWire(first));
      expect(await footprint(s, st)).toEqual(before);
    });

    it("I-3 Red. Same key, a changed quantity: 409 IDEMPOTENCY_KEY_CONFLICT PAYMENT_MISMATCH, nothing written", async () => {
      const s = await seedRun(`i3-${path}`, 2);
      const st = s.stops[0];
      const key = `k-${st.stopId}`;
      await complete(s, st, path, { ...withMoney(st, 8, 120), idempotencyKey: key });
      const before = await footprint(s, st);
      mockStorage.upload.mockClear();

      await expect(
        complete(s, st, path, {
          ...withMoney(st, 7, 120),
          idempotencyKey: key,
          podPhotoUrls: ["data:image/png;base64,AAAA"],
        }),
      ).rejects.toMatchObject({
        status: 409,
        response: expect.objectContaining({
          code: "IDEMPOTENCY_KEY_CONFLICT",
          reason: API_ERROR_CODES.PAYMENT_MISMATCH,
        }),
      });

      expect(await footprint(s, st)).toEqual(before);
      expect(mockStorage.upload).not.toHaveBeenCalled();
    });

    it("I-4 Guard. A refused completion leaves no key, and the retry with that key succeeds", async () => {
      const s = await seedRun(`i4-${path}`, 2);
      const st = s.stops[0];
      const key = `k-${st.stopId}`;

      await expect(
        complete(s, st, path, { ...withMoney(st, 999, 120), idempotencyKey: key }),
      ).rejects.toMatchObject({ status: 400 });
      expect(await keyRows(s, st, path, key)).toBe(0);
      expect((await footprint(s, st)).stop).toBe("IN_PROGRESS");

      await complete(s, st, path, { ...withMoney(st), idempotencyKey: key });
      expect((await footprint(s, st)).stop).toBe("COMPLETED");
    });

    it("I-4b Red. The key commits in the completion's transaction: a failure right after it undoes both", async () => {
      const s = await seedRun(`i4b-${path}`, 2);
      const st = s.stops[0];
      const key = `k-${st.stopId}`;
      const dto = { ...withMoney(st), idempotencyKey: key };
      const realSave = IdempotencyService.prototype.save;
      let stopSeenBySave: string | undefined;
      const save = jest
        .spyOn(IdempotencyService.prototype, "save")
        .mockImplementation(async function (this: IdempotencyService, ...args) {
          await realSave.apply(this, args);
          const tx = args[4];
          stopSeenBySave = (await tx.routeRunStop.findUnique({ where: { id: st.stopId } }))?.status;
          throw new Error("the commit never happens");
        });

      try {
        await expect(complete(s, st, path, dto)).rejects.toThrow("the commit never happens");
      } finally {
        save.mockRestore();
      }
      expect(stopSeenBySave).toBe("COMPLETED");
      expect(await keyRows(s, st, path, key)).toBe(0);
      const after = await footprint(s, st);
      expect([after.stop, after.mutations, after.payments]).toEqual(["IN_PROGRESS", 0, 0]);

      await complete(s, st, path, dto);
      expect(await keyRows(s, st, path, key)).toBe(1);
      expect((await footprint(s, st)).mutations).toBe(2);
    });

    it("I-6 Pin. A driver with no claim on the run gets 403 for a key that exists, and learns nothing", async () => {
      const s = await seedRun(`i6-${path}`, 2);
      const st = s.stops[0];
      const dto = { ...withMoney(st), idempotencyKey: `k-${st.stopId}` };
      await complete(s, st, path, dto);

      await expect(
        complete(s, st, path, dto, { sub: "sa1098-other", role: "DRIVER" } as never),
      ).rejects.toMatchObject({ status: 403 });
    });

    it("I-7 Pin. The key is per stop: the same key on another stop completes that stop", async () => {
      const s = await seedRun(`i7-${path}`, 3);
      const [a, b] = s.stops;
      await complete(s, a, path, { ...withMoney(a), idempotencyKey: "same-key" });
      await complete(s, b, path, { ...withMoney(b), idempotencyKey: "same-key" });
      expect((await footprint(s, b)).stop).toBe("COMPLETED");
      expect((await footprint(s, b)).mutations).toBe(2);
    });

    it("I-8 Pin. A new key after a commit still gets 400 Stop is already completed", async () => {
      const s = await seedRun(`i8-${path}`, 2);
      const st = s.stops[0];
      await complete(s, st, path, { ...withMoney(st), idempotencyKey: `k1-${st.stopId}` });
      const before = await footprint(s, st);

      await expect(
        complete(s, st, path, { ...withMoney(st), idempotencyKey: `k2-${st.stopId}` }),
      ).rejects.toMatchObject({ status: 400, message: "Stop is already completed" });

      expect(await footprint(s, st)).toEqual(before);
    });

    it("I-9 Pin. Two attempts at once with one key write one set of rows", async () => {
      const s = await seedRun(`i9-${path}`, 2);
      const st = s.stops[0];
      const dto = { ...withMoney(st), idempotencyKey: `k-${st.stopId}` };

      const results = await Promise.allSettled([
        complete(s, st, path, dto),
        complete(s, st, path, dto),
      ]);

      expect(results.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
      const after = await footprint(s, st);
      expect(after.stop).toBe("COMPLETED");
      expect(after.mutations).toBe(2);
      expect(after.payments).toBe(path === "completeWithPayment" ? 1 : 0);
    });
  });
});
