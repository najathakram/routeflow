/**
 * SA-706f, real Postgres: an operator CANCELS a run while a driver completes one of its stops.
 *
 * `completeStop` / `completeWithPayment` lock the stop's Orders first and then claim the stop
 * (Order -> RouteRunStop). `updateRunStatus` CANCELLED used to lock the run's STOP rows first and
 * then write Orders (RouteRunStop -> Order): the inverse, a 40P01 with the driver as the victim
 * (no retry, so an uncoded 500). The terminal move now locks the run's Orders BEFORE its stops, and
 * both completion transactions retry a conflict victim.
 *
 * Deterministic interleave: a raw pg connection T2 holds the RouteRunStop row FOR UPDATE. The run
 * PATCH starts FIRST and is observed blocked (it is queued ahead on the stop lock); the completion
 * starts second, takes its Orders and, on the old order, queues behind the PATCH on the stop. The
 * spec waits until BOTH backends are in a lock wait (counted by `pg_blocking_pids`, so unrelated
 * waiters never satisfy it), then T2 commits. Old order: the PATCH takes the stop and waits for the
 * Orders the completion holds while the completion waits for the stop: a deadlock, the completion
 * (waiting longest) the victim. New order: the PATCH holds the Orders, the completion waits behind
 * it, and is refused once the run is CANCELLED: one coded outcome, no deadlock.
 *
 * (A COMPLETED run PATCH cannot race a completion of the SAME stop: its stops-complete gate refuses a
 * run that still has a pending stop before any lock is taken; the last case pins that.)
 *
 * Collected only by `jest.db.config.js` (`npm run local:test:db`). Throwaway `qa-sa706f-<run>-<n>`
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
    `qa-sa706f-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "run-terminal-vs-stop-completion-sa706f.db.spec.ts",
  );
}

describeDb("a run CANCEL and a stop completion lock in one order (SA-706f)", () => {
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
          useValue: { writeSaleEntries: jest.fn(), reverseInvoiceEntries: jest.fn() },
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
    const tenant = await prisma.tenant.create({ data: { slug, name: `SA706f ${slug}` } });
    createdTenantIds.push(tenant.id);
    const tenantId = tenant.id;
    const idBase = `${tenantId}-${label}`;
    const user = await prisma.user.create({
      data: { email: `${idBase}@example.invalid`, username: idBase, role: "CUSTOMER", tenantId },
    });
    const customer = await prisma.customer.create({
      data: {
        userId: user.id,
        businessName: `SA706f customer ${label}`,
        contactName: `SA706f contact ${label}`,
        tenantId,
      },
    });
    const p1 = await prisma.product.create({
      data: { name: `SA706f P1 ${label}`, unit: "each", pricePerUnit: 10, tenantId },
    });
    const p2 = await prisma.product.create({
      data: { name: `SA706f P2 ${label}`, unit: "each", pricePerUnit: 5, tenantId },
    });
    const route = await prisma.route.create({ data: { name: `SA706f route ${label}`, tenantId } });
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
        orderNumber: `SA706f-${RUN_SUFFIX}-${label}`,
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

  /**
   * T2 holds the RouteRunStop row. `startFirst` starts and must block on T2; then `startSecond`
   * starts; both must be in a lock wait (backends with a non-empty `pg_blocking_pids`) before T2
   * commits.
   */
  async function raceOnHeldStop(
    stopId: string,
    startFirst: () => Promise<unknown>,
    startSecond: () => Promise<unknown>,
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
      const blockedBackends = async () =>
        (
          await t2.query(
            `SELECT pg_stat_clear_snapshot(), (SELECT count(*)::int FROM pg_stat_activity
               WHERE datname = current_database() AND pid <> $1
                 AND cardinality(pg_blocking_pids(pid)) > 0) AS n`,
            [pid],
          )
        ).rows[0].n as number;

      const first = settle(startFirst());
      let firstBlocked = 0;
      for (let i = 0; i < 120 && firstBlocked < 1; i++) {
        firstBlocked = await blockedByT2();
        if (firstBlocked < 1) await sleep(25);
      }
      const second = settle(startSecond());
      let blocked = 0;
      for (let i = 0; i < 120 && blocked < 2; i++) {
        blocked = await blockedBackends();
        if (blocked < 2) await sleep(25);
      }
      await t2.query("COMMIT");
      return { firstBlocked, blocked, results: await Promise.all([first, second]) };
    } finally {
      await t2.end().catch(() => undefined);
    }
  }

  const operator = { sub: "sa706f-operator", role: "OPERATOR" } as never;
  type Seed = Awaited<ReturnType<typeof seedOrderOnStop>>;

  const deliveriesOf = (s: Seed) => [
    { orderItemId: s.line1.id, type: "DELIVERED", quantityDelivered: 10 },
    { orderItemId: s.line2.id, type: "DELIVERED", quantityDelivered: 4 },
  ];

  async function cancelVersusCompletion(label: string, complete: (s: Seed) => Promise<unknown>) {
    const s = await seedOrderOnStop(label);
    const { firstBlocked, blocked, results } = await raceOnHeldStop(
      s.runStop.id,
      () =>
        tenantCtx.run(s.tenantId, () =>
          routesService.updateRunStatus(s.run.id, { status: "CANCELLED" } as never, operator),
        ),
      () => tenantCtx.run(s.tenantId, () => complete(s)),
    );
    expect(firstBlocked).toBeGreaterThanOrEqual(1); // the PATCH waits on T2 (queued ahead)
    expect(blocked).toBeGreaterThanOrEqual(2); // and the completion is waiting too
    const [cancel, completion] = results as Array<{ ok: boolean; e?: unknown }>;
    for (const r of [cancel, completion]) {
      if (!r.ok) expect(String((r.e as Error)?.message)).not.toMatch(/40P01|deadlock detected/i);
    }
    expect(cancel.ok).toBe(true); // the cancel always wins: it holds the Orders first
    expect(completion.ok).toBe(false); // the completion is refused once the run is CANCELLED
    expect(completion.e).toBeInstanceOf(HttpException); // a coded refusal, never a bare Prisma error
    const run = await prisma.routeRun.findUniqueOrThrow({ where: { id: s.run.id } });
    expect(run.status).toBe("CANCELLED");
    const stop = await prisma.routeRunStop.findUniqueOrThrow({ where: { id: s.runStop.id } });
    expect(stop.status).not.toBe("COMPLETED"); // the refused completion rolled back whole
    const order = await prisma.order.findUniqueOrThrow({ where: { id: s.order.id } });
    expect(order.status).toBe("CONFIRMED"); // released by the cancel, not delivered
    expect(order.routeRunStopId).toBeNull();
  }

  it("SA-706f: run CANCELLED vs completeStop on the same stop: no 40P01, the cancel wins, the completion is a coded refusal", async () => {
    await cancelVersusCompletion("cancel-vs-stop", (s) =>
      routesService.completeStop(
        s.run.id,
        s.runStop.id,
        { deliveries: deliveriesOf(s) } as never,
        operator,
      ),
    );
  }, 60_000);

  it("SA-706f: run CANCELLED vs completeWithPayment on the same stop: no 40P01, the cancel wins, the completion is a coded refusal", async () => {
    await cancelVersusCompletion("cancel-vs-payment", (s) =>
      routesService.completeWithPayment(
        s.run.id,
        s.runStop.id,
        { deliveries: deliveriesOf(s) } as never,
        operator,
      ),
    );
  }, 60_000);

  it("SA-706f: a COMPLETED run PATCH cannot race a completion of the same stop: its gate refuses a pending stop before any lock", async () => {
    const s = await seedOrderOnStop("complete-gate");
    await expect(
      tenantCtx.run(s.tenantId, () =>
        routesService.updateRunStatus(s.run.id, { status: "COMPLETED" } as never, operator),
      ),
    ).rejects.toMatchObject({ status: 400 });
    const run = await prisma.routeRun.findUniqueOrThrow({ where: { id: s.run.id } });
    expect(run.status).toBe("IN_PROGRESS");
  }, 60_000);
});
