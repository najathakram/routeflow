/**
 * SA-706d, real Postgres: `completeStop` and `completeWithPayment` complete ONE stop at the same time.
 *
 * Both paths now take the stop's ORDERS FOR UPDATE first (`lockStopOrdersAndFit`, id-ordered) and
 * only then claim the RouteRunStop, so there is one lock order (Order -> RouteRunStop) on every
 * path. Before, `completeStop` claimed the stop FIRST and wrote the orders after while
 * `completeWithPayment` locked the orders first: the same stop completed through both endpoints at
 * once was a lock-order cycle (40P01, an uncoded 500).
 *
 * The interleave is made deterministic with a raw pg connection T2 that holds the RouteRunStop row
 * FOR UPDATE: A (`completeStop`) is started first and observed blocked by T2, then B
 * (`completeWithPayment`) is started and the spec waits until BOTH are in a lock wait (bounded 3 s <
 * the 5 s transaction timeout; asserted, never a silent timeout). T2 then commits. On the OLD order
 * A (stop first) claims the stop and waits for the Orders that B already holds while B waits for the
 * stop: one of them is a 40P01 victim (a bare PrismaClientKnownRequestError). On the new order A
 * took the Orders before it ever asked for the stop, so B waits behind A and then is refused:
 * exactly one completes, the other gets the stop-claim 409, and neither is a deadlock victim.
 *
 * Collected only by `jest.db.config.js` (`npm run local:test:db`). Throwaway `qa-sa706d-<run>-<n>`
 * tenants approved by `assertTestTenant`; `afterAll` deletes what this run created.
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
import { Client } from "pg";
import { ConflictException, HttpException } from "@nestjs/common";
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
    `qa-sa706d-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "stop-completion-order-first-sa706d.db.spec.ts",
  );
}

describeDb("completeStop and completeWithPayment lock the stop's Orders first (SA-706d)", () => {
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
    const tenant = await prisma.tenant.create({ data: { slug, name: `SA706d ${slug}` } });
    createdTenantIds.push(tenant.id);
    const tenantId = tenant.id;
    const idBase = `${tenantId}-${label}`;
    const user = await prisma.user.create({
      data: { email: `${idBase}@example.invalid`, username: idBase, role: "CUSTOMER", tenantId },
    });
    const customer = await prisma.customer.create({
      data: {
        userId: user.id,
        businessName: `SA706d customer ${label}`,
        contactName: `SA706d contact ${label}`,
        tenantId,
      },
    });
    const p1 = await prisma.product.create({
      data: { name: `SA706d P1 ${label}`, unit: "each", pricePerUnit: 10, tenantId },
    });
    const p2 = await prisma.product.create({
      data: { name: `SA706d P2 ${label}`, unit: "each", pricePerUnit: 5, tenantId },
    });
    const route = await prisma.route.create({ data: { name: `SA706d route ${label}`, tenantId } });
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
        orderNumber: `SA706d-${RUN_SUFFIX}-${label}`,
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

  /** T2 holds the RouteRunStop row; A starts and must block on T2; then B starts; both must be waiting before T2 commits. */
  async function raceOnHeldStop(
    stopId: string,
    startA: () => Promise<unknown>,
    startB: () => Promise<unknown>,
  ) {
    const t2 = new Client({ connectionString: process.env.DATABASE_URL });
    await t2.connect();
    const settle = (p: Promise<unknown>) =>
      p.then(
        (v) => ({ ok: true as const, v }),
        (e) => ({ ok: false as const, e }),
      );
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    try {
      await t2.query("BEGIN");
      await t2.query(`SELECT id FROM "RouteRunStop" WHERE id = $1 FOR UPDATE`, [stopId]);
      const pid = (await t2.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const blockedByT2 = async () =>
        (
          await t2.query(
            `SELECT pg_stat_clear_snapshot(), (SELECT count(*)::int FROM pg_stat_activity
               WHERE $1 = ANY(pg_blocking_pids(pid))) AS n`,
            [pid],
          )
        ).rows[0].n as number;

      const a = settle(startA());
      let aBlocked = 0;
      for (let i = 0; i < 120 && aBlocked < 1; i++) {
        aBlocked = await blockedByT2();
        if (aBlocked < 1) await sleep(25);
      }
      const b = settle(startB());
      let lockWaiters = 0;
      for (let i = 0; i < 120 && lockWaiters < 2; i++) {
        const q = await t2.query(
          `SELECT pg_stat_clear_snapshot(), (SELECT count(*)::int FROM pg_stat_activity
             WHERE datname = current_database() AND pid <> $1 AND wait_event_type = 'Lock') AS n`,
          [pid],
        );
        lockWaiters = q.rows[0].n;
        if (lockWaiters < 2) await sleep(25);
      }
      await t2.query("COMMIT");
      return { aBlocked, lockWaiters, results: await Promise.all([a, b]) };
    } finally {
      await t2.end().catch(() => undefined);
    }
  }

  it("SA-706d: one stop completed through BOTH endpoints at once: no 40P01, one completes, the other is refused 409", async () => {
    const s = await seedOrderOnStop("race");
    const operator = { sub: "sa706d-operator", role: "OPERATOR" } as never;
    const deliveries = [
      { orderItemId: s.line1.id, type: "DELIVERED", quantityDelivered: 10 },
      { orderItemId: s.line2.id, type: "DELIVERED", quantityDelivered: 4 },
    ];
    const { aBlocked, lockWaiters, results } = await raceOnHeldStop(
      s.runStop.id,
      () =>
        tenantCtx.run(s.tenantId, () =>
          routesService.completeStop(s.run.id, s.runStop.id, { deliveries } as never, operator),
        ),
      () =>
        tenantCtx.run(s.tenantId, () =>
          routesService.completeWithPayment(
            s.run.id,
            s.runStop.id,
            { deliveries } as never,
            operator,
          ),
        ),
    );

    expect(aBlocked).toBeGreaterThanOrEqual(1); // A reached the stop claim and waits on T2
    expect(lockWaiters).toBeGreaterThanOrEqual(2); // and B is waiting too (behind A, or on T2 itself)

    const failed = results.filter((r) => !r.ok) as Array<{ ok: false; e: unknown }>;
    for (const f of failed) {
      expect(String((f.e as Error)?.message)).not.toMatch(/40P01|deadlock detected/i);
    }
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].e).toBeInstanceOf(HttpException);
    expect(failed[0].e).toBeInstanceOf(ConflictException); // "already completed by another request"
    const stop = await prisma.routeRunStop.findUniqueOrThrow({ where: { id: s.runStop.id } });
    expect(stop.status).toBe("COMPLETED");
  }, 60_000);
});
