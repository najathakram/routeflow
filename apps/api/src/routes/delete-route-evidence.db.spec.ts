/**
 * SA-842 / B209 / #1402 (tier 1) — real-Postgres pins for delivery evidence on the route / run delete paths.
 *
 * R4-DB (the race): a driver's start + stop completion (with a signature) holds the Order and stop-row locks
 * UNCOMMITTED while deleteRoute runs. deleteRoute must WAIT on those locks (every blocked backend in the
 * database is counted, and the wait ends < 5 s after the completion commits), then re-read under them and
 * refuse with 409 ROUTE_HAS_DELIVERY_EVIDENCE: the stop row, its signature key and the order pins persist.
 * Master reads before the tx and never re-reads: it deletes the fresh signature. Fix-revert probe: drop the
 * lock helper (or read the runs before the tx again) and the "blocked" / "refused" lines go red.
 *
 * The clause table proves the Prisma where syntax (`isEmpty`, `Prisma.AnyNull`, the relation filter,
 * `startsWith`) and every column name against the real schema; the in-memory double cannot.
 *
 * Collected only by `jest.db.config.js`; run via `npm run local:test:db`. SAFETY: throwaway
 * `qa-842-<run>-<n>-<label>` tenants approved by `assertTestTenant`; `afterAll` deletes exactly the
 * tenants THIS run created, best-effort. Nothing touches a live tenant.
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
import { prismaQueryable, waitUntilBlocked } from "../common/testing/blocked-wait";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
function freshTenantSlug(label: string): string {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-842-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "delete-route-evidence.db.spec.ts",
  );
}

const SIGNATURE = "tenants/qa/pod/stop/signature-x.png";

describeDb("SA-842 route / run delete keys on delivery evidence — real Postgres", () => {
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
        {
          provide: FeatureConfigService,
          useValue: {
            get: jest.fn(),
            isEnabled: jest.fn(),
            getEffectiveMode: jest.fn().mockResolvedValue("unset"), // createRun's dispatch gate
          },
        },
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
    await prisma.advancePayment.deleteMany({ where: { tenantId } });
    await prisma.orderItem.deleteMany({ where: { tenantId } });
    await prisma.order.deleteMany({ where: { tenantId } });
    await prisma.routeRunStop.deleteMany({ where: { tenantId } });
    await prisma.routeRun.deleteMany({ where: { tenantId } });
    await prisma.routeStop.deleteMany({ where: { tenantId } });
    await prisma.route.deleteMany({ where: { tenantId } });
    await prisma.customer.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  }

  /** One route, one run, one bare PENDING stop and one order pinned to that run and stop. */
  async function seed(label: string, runStatus: "SCHEDULED" | "CANCELLED" | "IN_PROGRESS") {
    const slug = freshTenantSlug(label);
    const tenant = await prisma.tenant.create({ data: { slug, name: `SA-842 ${slug}` } });
    createdTenantIds.push(tenant.id);
    const tenantId = tenant.id;
    const idBase = `${tenantId}-${label}`;
    const user = await prisma.user.create({
      data: { email: `${idBase}@example.invalid`, username: idBase, role: "CUSTOMER", tenantId },
    });
    const customer = await prisma.customer.create({
      data: {
        userId: user.id,
        businessName: `SA-842 customer ${label}`,
        contactName: `SA-842 contact ${label}`,
        tenantId,
      },
    });
    const route = await prisma.route.create({ data: { name: `SA-842 route ${label}`, tenantId } });
    const routeStop = await prisma.routeStop.create({
      data: { routeId: route.id, customerId: customer.id, stopNumber: 1, tenantId },
    });
    const run = await prisma.routeRun.create({
      data: { routeId: route.id, status: runStatus, scheduledDate: new Date(), tenantId },
    });
    const stop = await prisma.routeRunStop.create({
      data: {
        routeRunId: run.id,
        routeStopId: routeStop.id,
        customerId: customer.id,
        stopNumber: 1,
        status: "PENDING",
        tenantId,
      },
    });
    const order = await prisma.order.create({
      data: {
        customerId: customer.id,
        status: "OUT_FOR_DELIVERY",
        orderNumber: `SA842-${RUN_SUFFIX}-${label}`,
        routeRunId: run.id,
        routeRunStopId: stop.id,
        subtotal: 10,
        tax: 0,
        total: 10,
        tenantId,
      },
    });
    return { tenantId, route, routeStop, run, stop, order, customer };
  }
  type Seeded = Awaited<ReturnType<typeof seed>>;

  const inTenant = <T>(s: Seeded, fn: () => Promise<T>) => tenantCtx.run(s.tenantId, fn);
  const settle = (p: Promise<unknown>) =>
    p.then(
      () => ({ ok: true as const, code: null as string | null }),
      (e: any) => ({
        ok: false as const,
        code: (e?.getResponse?.()?.code ?? e?.message) as string | null,
      }),
    );

  /**
   * SA-425b: poll until some backend is WAITING on another (through `blocked-wait.ts`, which re-reads
   * the stats view on every probe) or until `done` settles. Counts ALL blocked backends in the
   * database. Returns true only when one was actually observed.
   */
  async function observeBlocked(done: Promise<unknown>, timeoutMs = 20_000): Promise<boolean> {
    let settled = false;
    void done.then(
      () => (settled = true),
      () => (settled = true),
    );
    const blocked = await waitUntilBlocked(prismaQueryable(prisma), {
      timeoutMs,
      intervalMs: 50,
      until: () => settled,
    });
    if (blocked.length > 0) return true;
    if (settled) return false;
    throw new Error("the delete neither blocked nor finished");
  }

  it("REG-B209 R4-DB: deleteRoute waits for an uncommitted start + signed completion, then refuses; the stop, signature and order pins persist", async () => {
    const s = await seed("race", "SCHEDULED");

    // T2 = the driver: start the run and complete the stop with a signature, Orders then stop row (the
    // house order), held UNCOMMITTED until released.
    let release!: () => void;
    const mayCommit = new Promise<void>((r) => (release = r));
    let held!: () => void;
    const holding = new Promise<void>((r) => (held = r));
    const completion = prisma.$transaction(
      async (tx: any) => {
        await tx.$queryRaw`SELECT id FROM "Order" WHERE "routeRunStopId" = ${s.stop.id} ORDER BY id FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM "RouteRunStop" WHERE id = ${s.stop.id} FOR UPDATE`;
        await tx.routeRun.update({
          where: { id: s.run.id },
          data: { status: "IN_PROGRESS", startedAt: new Date() },
        });
        await tx.routeRunStop.update({
          where: { id: s.stop.id },
          data: { status: "COMPLETED", completedAt: new Date(), signatureUrl: SIGNATURE },
        });
        held();
        await mayCommit;
      },
      { timeout: 60_000 },
    );
    await holding;

    const deletion = settle(inTenant(s, () => routesService.deleteRoute(s.route.id)));
    let blocked: boolean;
    let releasedAt = 0;
    try {
      blocked = await observeBlocked(deletion);
    } finally {
      // Always let T2 commit, so a harness failure can never leave its tx (and the cleanup) hung.
      releasedAt = Date.now();
      release();
    }
    await completion;
    const outcome = await deletion;
    const waitedMs = Date.now() - releasedAt;

    const stop = await prisma.routeRunStop.findUnique({ where: { id: s.stop.id } });
    const order = await prisma.order.findUnique({ where: { id: s.order.id } });
    // WRONG VALUE TODAY (master): the delete reads the runs BEFORE its tx (SCHEDULED, bare), passes,
    // queues on the order row, then deletes the freshly signed stop: refused false, stopSignature null,
    // orderPins [null, null], routeStillThere false.
    expect({
      blocked,
      refused: outcome.ok === false && outcome.code === "ROUTE_HAS_DELIVERY_EVIDENCE",
      under5s: waitedMs < 5000,
      stopSignature: stop?.signatureUrl ?? null,
      orderPins: [order?.routeRunId ?? null, order?.routeRunStopId ?? null],
      routeStillThere: (await prisma.route.count({ where: { id: s.route.id } })) === 1,
    }).toEqual({
      blocked: true,
      refused: true,
      under5s: true,
      stopSignature: SIGNATURE,
      orderPins: [s.run.id, s.stop.id],
      routeStillThere: true,
    });
  });

  it("REG-B209 R1-DB: a CANCELLED run that kept a signed stop is refused, nothing is written", async () => {
    const s = await seed("r1", "CANCELLED");
    await prisma.routeRunStop.update({
      where: { id: s.stop.id },
      data: { status: "COMPLETED", completedAt: new Date(), signatureUrl: SIGNATURE },
    });

    const outcome = await settle(inTenant(s, () => routesService.deleteRoute(s.route.id)));

    expect(outcome).toEqual({ ok: false, code: "ROUTE_HAS_DELIVERY_EVIDENCE" });
    expect(await prisma.routeRunStop.count({ where: { id: s.stop.id } })).toBe(1);
    expect(await prisma.routeRun.count({ where: { id: s.run.id } })).toBe(1);
    expect(await prisma.routeStop.count({ where: { id: s.routeStop.id } })).toBe(1);
    expect(await prisma.route.count({ where: { id: s.route.id } })).toBe(1);
    const order = await prisma.order.findUnique({ where: { id: s.order.id } });
    expect([order?.routeRunId, order?.routeRunStopId]).toEqual([s.run.id, s.stop.id]);
  });

  // Each mutator adds ONE record the predicate must see. A wrong column name, or a Prisma where the client
  // rejects, fails here on the real schema. The bare seed is deletable (control below).
  const CLAUSES: Array<[string, (s: Seeded) => Promise<unknown>]> = [
    [
      "stop podPhotoUrls",
      (s) =>
        prisma.routeRunStop.update({
          where: { id: s.stop.id },
          data: { podPhotoUrls: ["tenants/qa/pod/stop/p1.jpg"] },
        }),
    ],
    [
      "stop podHistory (Json)",
      (s) =>
        prisma.routeRunStop.update({
          where: { id: s.stop.id },
          data: { podHistory: [{ archivedAt: "2026-10-01T00:00:00Z", reason: "reopen" }] },
        }),
    ],
    [
      "stop driverNote",
      (s) =>
        prisma.routeRunStop.update({
          where: { id: s.stop.id },
          data: { driverNote: "left at door" },
        }),
    ],
    [
      "stop ageVerified",
      (s) => prisma.routeRunStop.update({ where: { id: s.stop.id }, data: { ageVerified: true } }),
    ],
    [
      "run settlementNote",
      (s) => prisma.routeRun.update({ where: { id: s.run.id }, data: { settlementNote: "short" } }),
    ],
    [
      "a DeliveryMutation on the stop",
      (s) =>
        prisma.deliveryMutation.create({
          data: {
            orderId: s.order.id,
            routeRunStopId: s.stop.id,
            type: "DELIVERED",
            tenantId: s.tenantId,
          },
        }),
    ],
    [
      "delivered qty on the run's order",
      (s) =>
        prisma.orderItem.create({
          data: {
            orderId: s.order.id,
            name: "SA-842 line",
            qty: 2,
            deliveredQty: 1,
            unitPrice: 5,
            subtotal: 10,
            tenantId: s.tenantId,
          },
        }),
    ],
    [
      "door cash AdvancePayment (RUN:<run>:STOP:<stop>, reversed)",
      (s) =>
        prisma.advancePayment.create({
          data: {
            customerId: s.customer.id,
            amount: 5,
            balance: 5,
            method: "CASH",
            reference: `RUN:${s.run.id}:STOP:${s.stop.id}:REVERSED`,
            tenantId: s.tenantId,
          },
        }),
    ],
  ];

  it.each(CLAUSES)(
    "REG-B209 clause (real schema): %s makes the route undeletable",
    async (label, mutate) => {
      const s = await seed(
        `c-${label.replace(/\W+/g, "").slice(0, 14).toLowerCase()}`,
        "CANCELLED",
      );
      await mutate(s);

      const outcome = await settle(inTenant(s, () => routesService.deleteRoute(s.route.id)));

      expect(outcome).toEqual({ ok: false, code: "ROUTE_HAS_DELIVERY_EVIDENCE" });
      expect(await prisma.routeRunStop.count({ where: { id: s.stop.id } })).toBe(1);
      expect(await prisma.route.count({ where: { id: s.route.id } })).toBe(1);
    },
  );

  it("REG-B209 control: dispatch-time fields are NOT evidence — the route deletes and its order is released, not deleted", async () => {
    const s = await seed("control", "CANCELLED");
    await prisma.routeRunStop.update({
      where: { id: s.stop.id },
      data: { notes: "gate code", safeDropEnabled: true, ageCheckRequired: true },
    });
    await prisma.routeRun.update({ where: { id: s.run.id }, data: { notes: "load early" } });

    const outcome = await settle(inTenant(s, () => routesService.deleteRoute(s.route.id)));

    expect(outcome).toEqual({ ok: true, code: null });
    expect(await prisma.route.count({ where: { id: s.route.id } })).toBe(0);
    expect(await prisma.routeRun.count({ where: { id: s.run.id } })).toBe(0);
    expect(await prisma.routeRunStop.count({ where: { id: s.stop.id } })).toBe(0);
    const order = await prisma.order.findUnique({ where: { id: s.order.id } });
    expect([order?.routeRunId, order?.routeRunStopId]).toEqual([null, null]);
  });

  it("REG-B209 R5-DB: deleteRun refuses a CANCELLED run whose stop has a signature and no DeliveryMutation", async () => {
    const s = await seed("r5", "CANCELLED");
    await prisma.routeRunStop.update({
      where: { id: s.stop.id },
      data: { status: "COMPLETED", completedAt: new Date(), signatureUrl: SIGNATURE },
    });

    const outcome = await settle(inTenant(s, () => routesService.deleteRun(s.run.id)));

    expect(outcome).toEqual({ ok: false, code: "ROUTE_HAS_DELIVERY_EVIDENCE" });
    expect(await prisma.routeRunStop.count({ where: { id: s.stop.id } })).toBe(1);
    expect(await prisma.routeRun.count({ where: { id: s.run.id } })).toBe(1);
  });

  it("REG-B209 R5-DB (guard): deleteRun deletes a bare SCHEDULED run and releases its order", async () => {
    const s = await seed("r5g", "SCHEDULED");

    const outcome = await settle(inTenant(s, () => routesService.deleteRun(s.run.id)));

    expect(outcome).toEqual({ ok: true, code: null });
    expect(await prisma.routeRun.count({ where: { id: s.run.id } })).toBe(0);
    expect(await prisma.routeRunStop.count({ where: { id: s.stop.id } })).toBe(0);
    const order = await prisma.order.findUnique({ where: { id: s.order.id } });
    expect([order?.routeRunId, order?.routeRunStopId]).toEqual([null, null]);
  });
});
