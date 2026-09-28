/**
 * #2135 / #2562 (F2 on #2554): the run-stop reorder must take the RouteRun row lock before it reads
 * the run's status. `reorderRunStopsInTx` issues `SELECT id FROM "RouteRun" ... FOR UPDATE` first,
 * then reads the run and its stops inside that one transaction, and refuses an IN_PROGRESS run.
 *
 * The race: a run START (status -> IN_PROGRESS) that commits while a reorder is running. T2 plays the
 * start: it updates the RouteRun row (taking its row lock) and holds its tx open. A starts the
 * reorder. We wait until A is either blocked on a lock or already finished, then T2 commits.
 * With the lock: A waits, then reads IN_PROGRESS and is refused, and the stop numbers are untouched.
 * Without it: A reads the pre-start SCHEDULED status and renumbers the stops of a run that just
 * started.
 *
 * WHY THE DB LANE: only real row locks and two real connections can show the interleaving.
 * Collected only by `jest.db.config.js`; run via `npm run local:test:db`.
 *
 * SAFETY: throwaway `qa-2562-<run>-<n>-<label>` tenants approved by `assertTestTenant`; `afterAll`
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
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";
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
    `qa-2562-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "run-stop-reorder-lock.db.spec.ts",
  );
}

describeDb("#2562 run-stop reorder vs a concurrent run start — real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let routesService: RoutesService;
  const createdTenantIds: string[] = [];

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
        {
          provide: RouteFlowGateway,
          useValue: {
            emitInvoiceUpdated: jest.fn(),
            emitOrderCreated: jest.fn(),
            emitOrderStatusChanged: jest.fn(),
            emitStopCompleted: jest.fn(),
            emitUrgentOrder: jest.fn(),
            emitRunUpdated: jest.fn(),
          },
        },
        {
          provide: NotificationsService,
          useValue: {
            create: jest.fn().mockResolvedValue(undefined),
            notify: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(undefined) } },
        { provide: FeatureConfigService, useValue: { get: jest.fn(), isEnabled: jest.fn() } },
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
          useValue: { upload: jest.fn(), presignedUrl: jest.fn(), delete: jest.fn() },
        },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        entitlementAuthorityFromEntitlements, // #2241: EntitlementAuthority
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

    routesService = module.get(RoutesService);
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

  /** A SCHEDULED run with two PENDING stops (numbers 1 and 2). */
  async function seedRunWithTwoStops(label: string) {
    const slug = freshTenantSlug(label);
    const tenant = await prisma.tenant.create({ data: { slug, name: `#2562 ${slug}` } });
    createdTenantIds.push(tenant.id);
    const tenantId = tenant.id;
    const idBase = `${tenantId}-${label}`;
    const user = await prisma.user.create({
      data: { email: `${idBase}@example.invalid`, username: idBase, role: "CUSTOMER", tenantId },
    });
    const customer = await prisma.customer.create({
      data: {
        userId: user.id,
        businessName: `#2562 customer ${label}`,
        contactName: `#2562 contact ${label}`,
        tenantId,
      },
    });
    const route = await prisma.route.create({ data: { name: `#2562 route ${label}`, tenantId } });
    const rs1 = await prisma.routeStop.create({
      data: { routeId: route.id, customerId: customer.id, stopNumber: 1, tenantId },
    });
    const rs2 = await prisma.routeStop.create({
      data: { routeId: route.id, customerId: customer.id, stopNumber: 2, tenantId },
    });
    const run = await prisma.routeRun.create({
      data: { routeId: route.id, status: "SCHEDULED", scheduledDate: new Date(), tenantId },
    });
    const stop1 = await prisma.routeRunStop.create({
      data: {
        routeRunId: run.id,
        routeStopId: rs1.id,
        customerId: customer.id,
        stopNumber: 1,
        status: "PENDING",
        tenantId,
      },
    });
    const stop2 = await prisma.routeRunStop.create({
      data: {
        routeRunId: run.id,
        routeStopId: rs2.id,
        customerId: customer.id,
        stopNumber: 2,
        status: "PENDING",
        tenantId,
      },
    });
    return { tenantId, run, stop1, stop2 };
  }

  /**
   * SA-425b: poll until some backend is WAITING on another (`pg_blocking_pids` non-empty, with
   * `pg_stat_clear_snapshot()` each poll so the stats view is re-read) or until `done` settles.
   * Returns true only when a blocked backend was actually observed.
   */
  async function observeBlocked(done: Promise<unknown>, timeoutMs = 20_000): Promise<boolean> {
    let settled = false;
    void done.then(
      () => (settled = true),
      () => (settled = true),
    );
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await prisma.$executeRaw`SELECT pg_stat_clear_snapshot()`; // returns void: $executeRaw
      const rows: Array<{ n: bigint | number }> = await prisma.$queryRaw`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE cardinality(pg_blocking_pids(pid)) > 0`;
      if (Number(rows[0]?.n ?? 0) > 0) return true;
      if (settled) return false;
      if (Date.now() > deadline) throw new Error("the reorder neither blocked nor finished");
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  it("#2562: a run start that commits while the reorder waits on the run lock refuses the reorder", async () => {
    const s = await seedRunWithTwoStops("race");

    // T2, the run start: the RouteRun row goes IN_PROGRESS, held open until released.
    let releaseStart!: () => void;
    const startMayCommit = new Promise<void>((r) => (releaseStart = r));
    let startHoldsRow!: () => void;
    const startLocked = new Promise<void>((r) => (startHoldsRow = r));
    const start = prisma.$transaction(
      async (tx: any) => {
        await tx.routeRun.update({
          where: { id: s.run.id },
          data: { status: "IN_PROGRESS", startedAt: new Date() },
        });
        startHoldsRow();
        await startMayCommit;
      },
      { timeout: 60_000 },
    );
    await startLocked;

    // A, the reorder: swap the two stops while T2 still holds the RouteRun row.
    const reorder = tenantCtx
      .run(s.tenantId, () =>
        routesService.reorderRunStops(s.run.id, [
          { id: s.stop1.id, stopNumber: 2 },
          { id: s.stop2.id, stopNumber: 1 },
        ]),
      )
      .then(
        () => ({ ok: true as const }),
        (e: unknown) => ({ ok: false as const, error: e as Error }),
      );

    let blocked: boolean;
    try {
      blocked = await observeBlocked(reorder);
    } finally {
      // Always let T2 commit, so a harness failure can never leave its tx (and the cleanup) hung.
      releaseStart();
    }
    await start;
    const outcome = await reorder;

    const stops = await prisma.routeRunStop.findMany({
      where: { routeRunId: s.run.id },
      select: { id: true, stopNumber: true },
    });
    const numberOf = (id: string) => stops.find((x) => x.id === id)?.stopNumber;
    expect({
      blocked,
      refused: !outcome.ok,
      message: outcome.ok ? null : outcome.error.message,
      stop1: numberOf(s.stop1.id),
      stop2: numberOf(s.stop2.id),
    }).toEqual({
      blocked: true,
      refused: true,
      message: "Cannot reorder stops on an active or completed route run",
      stop1: 1,
      stop2: 2,
    });
  });

  it("control: with no concurrent status change the same reorder renumbers the stops", async () => {
    const s = await seedRunWithTwoStops("control");
    await tenantCtx.run(s.tenantId, () =>
      routesService.reorderRunStops(s.run.id, [
        { id: s.stop1.id, stopNumber: 2 },
        { id: s.stop2.id, stopNumber: 1 },
      ]),
    );
    const stops = await prisma.routeRunStop.findMany({
      where: { routeRunId: s.run.id },
      select: { id: true, stopNumber: true },
    });
    const numberOf = (id: string) => stops.find((x) => x.id === id)?.stopNumber;
    expect({ stop1: numberOf(s.stop1.id), stop2: numberOf(s.stop2.id) }).toEqual({
      stop1: 2,
      stop2: 1,
    });
  });
});
