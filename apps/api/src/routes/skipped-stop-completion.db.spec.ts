/**
 * #2409 (tier 1) — real-Postgres pin. F2 (#938 5852576425) proved it on the web export: a driver's
 * completion queued OFFLINE while the office SKIPPED the stop replayed on reconnect and got 201 —
 * a skipped stop became completed. Both completion paths must refuse a SKIPPED stop (409
 * STOP_SKIPPED) and leave it SKIPPED; the atomic claim must refuse too when the skip lands between
 * the service's guard and its write. Fixture tenants are throwaway `qa-2409-*` slugs
 * (assertTestTenant); nothing touches a live tenant.
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
import { EstimatesService } from "../estimates/estimates.service";
import { NumberingService } from "../import/numbering.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { claimStopCompletion } from "./delivery-lines.util";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
function freshTenantSlug(label: string): string {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-2409-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "skipped-stop-completion.db.spec.ts",
  );
}

describeDb("#2409 a SKIPPED stop refuses a replayed completion — real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let routesService: RoutesService;
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
        { provide: EntitlementsService, useValue: mockEntitlements },
        entitlementAuthorityFromEntitlements, // #2241
        { provide: CommissionEngineService, useValue: mockCommissionEngine },
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

  /** `secondStop` (SA-533a): a second PENDING stop keeps the run IN_PROGRESS after the first
   *  stop completes, so a racing PATCH reaches the stop CAS instead of the run-status 409. */
  async function seedSkippedStop(label: string, opts: { secondStop?: boolean } = {}) {
    const slug = freshTenantSlug(label);
    const tenant = await prisma.tenant.create({ data: { slug, name: `#2409 ${slug}` } });
    createdTenantIds.push(tenant.id);
    const tenantId = tenant.id;
    const idBase = `${tenantId}-${label}`;
    const user = await prisma.user.create({
      data: { email: `${idBase}@example.invalid`, username: idBase, role: "CUSTOMER", tenantId },
    });
    const customer = await prisma.customer.create({
      data: {
        userId: user.id,
        businessName: `#2409 ${label}`,
        contactName: `#2409 ${label}`,
        tenantId,
      },
    });
    const route = await prisma.route.create({ data: { name: `#2409 route ${label}`, tenantId } });
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
        status: "SKIPPED",
        tenantId,
      },
    });
    if (opts.secondStop) {
      const routeStop2 = await prisma.routeStop.create({
        data: { routeId: route.id, customerId: customer.id, stopNumber: 2, tenantId },
      });
      await prisma.routeRunStop.create({
        data: {
          routeRunId: run.id,
          routeStopId: routeStop2.id,
          customerId: customer.id,
          stopNumber: 2,
          status: "PENDING",
          tenantId,
        },
      });
    }
    return { tenantId, runId: run.id, stopId: runStop.id };
  }

  const operator = { sub: "op-2409", role: "OPERATOR" } as never;

  /** #2414 Opus nit: a refused completion leaves no delivery or payment rows behind. */
  async function expectNothingWritten(s: { tenantId: string; stopId: string }) {
    expect(await prisma.deliveryMutation.count({ where: { routeRunStopId: s.stopId } })).toBe(0);
    expect(await prisma.invoicePayment.count({ where: { tenantId: s.tenantId } })).toBe(0);
    expect(await prisma.payment.count({ where: { tenantId: s.tenantId } })).toBe(0);
  }

  /** The only two ways a skip may lose to a completion (#2415 CAS code, or the B71 pre-read 409). */
  function isSkipLostToCompletion(err: unknown): boolean {
    const response = (err as { getResponse?: () => unknown })?.getResponse?.();
    if ((response as { code?: string } | undefined)?.code === "STOP_ALREADY_COMPLETED") return true;
    return (
      (err as Error)?.message ===
      "This stop is completed. Reopen it instead — that reverses the delivery correctly."
    );
  }

  async function setStopStatus(stopId: string, status: "PENDING" | "SKIPPED") {
    await prisma.routeRunStop.update({ where: { id: stopId }, data: { status } });
  }

  it("completeWithPayment replayed onto a SKIPPED stop: 409 STOP_SKIPPED, the stop stays SKIPPED", async () => {
    const s = await seedSkippedStop("cwp");
    await expect(
      tenantCtx.run(s.tenantId, () =>
        routesService.completeWithPayment(
          s.runId,
          s.stopId,
          { deliveries: [], idempotencyKey: `k-${s.stopId}` } as never,
          operator,
        ),
      ),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: "STOP_SKIPPED" }) });
    const after = await prisma.routeRunStop.findUnique({ where: { id: s.stopId } });
    expect(after?.status).toBe("SKIPPED");
    expect(after?.completedAt).toBeNull();
    await expectNothingWritten(s);
  });

  it("completeStop replayed onto a SKIPPED stop: 409 STOP_SKIPPED, the stop stays SKIPPED", async () => {
    const s = await seedSkippedStop("cs");
    await expect(
      tenantCtx.run(s.tenantId, () =>
        routesService.completeStop(s.runId, s.stopId, { deliveries: [] } as never, operator),
      ),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: "STOP_SKIPPED" }) });
    const after = await prisma.routeRunStop.findUnique({ where: { id: s.stopId } });
    expect(after?.status).toBe("SKIPPED");
    await expectNothingWritten(s);
  });

  it("the atomic claim on a real row: a SKIPPED stop is never claimed (a skip that races the guard)", async () => {
    const s = await seedSkippedStop("claim");
    await expect(
      prisma.$transaction((tx) =>
        claimStopCompletion(tx, s.stopId, { status: "COMPLETED", completedAt: new Date() }),
      ),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: "STOP_SKIPPED" }) });
    const after = await prisma.routeRunStop.findUnique({ where: { id: s.stopId } });
    expect(after?.status).toBe("SKIPPED");
  });

  it("#2415: skip vs complete race on a real PENDING row — exactly one winner, never COMPLETED→SKIPPED", async () => {
    for (let round = 0; round < 5; round++) {
      // SA-533a: a TWO-stop run — on one stop the completion also completes the run, and #2514's
      // run re-check then refuses the skip before it can meet the #2415 stop CAS pinned here.
      const s = await seedSkippedStop(`race${round}`, { secondStop: true });
      await setStopStatus(s.stopId, "PENDING");
      const [complete, skip] = await Promise.allSettled([
        tenantCtx.run(s.tenantId, () =>
          routesService.completeWithPayment(
            s.runId,
            s.stopId,
            { deliveries: [] } as never,
            operator,
          ),
        ),
        tenantCtx.run(s.tenantId, () =>
          routesService.updateStopStatus(s.runId, s.stopId, { status: "SKIPPED" }, operator),
        ),
      ]);
      const after = await prisma.routeRunStop.findUnique({ where: { id: s.stopId } });
      // Never both: a completion and a skip can't both win the same row.
      expect(complete.status === "fulfilled" && skip.status === "fulfilled").toBe(false);
      if (after?.status === "COMPLETED") {
        expect(complete.status).toBe("fulfilled");
        // The skip loses in exactly one of two SPECIFIC ways (never "any rejection"): at the CAS
        // (#2415, 409 STOP_ALREADY_COMPLETED) or at its pre-read, which already saw COMPLETED (the
        // existing B71 409). The deterministic latch pin below pins the CAS path alone.
        expect(skip.status).toBe("rejected");
        expect(isSkipLostToCompletion((skip as PromiseRejectedResult).reason)).toBe(true);
      } else {
        expect(after?.status).toBe("SKIPPED");
        expect(skip.status).toBe("fulfilled");
        expect(complete.status).toBe("rejected");
        expect((complete as PromiseRejectedResult).reason).toMatchObject({
          response: expect.objectContaining({ code: "STOP_SKIPPED" }),
        });
        await expectNothingWritten(s);
      }
    }
  });

  it("#2415 DETERMINISTIC: a skip paused after its PENDING read, a completion commits, the skip resumes → 409 STOP_ALREADY_COMPLETED, the stop stays COMPLETED", async () => {
    // F2 (#938): the concurrent race above never produced the B707 interleave — the quick skip
    // always committed before completeWithPayment's long tx reached its claim. This latch forces
    // it: updateStopStatus reads the stop (PENDING), then reads the run via
    // forTenant().routeRun.findFirst — the pause point (AFTER that read), identical in the pre-#2415 code, so this
    // pin is RED on the old check-then-update (the skip overwrites COMPLETED with SKIPPED).
    // SA-533a: a TWO-stop run, so completing this stop leaves the run IN_PROGRESS and the paused
    // skip reaches the #2415 stop CAS (on one stop, #2514's run re-check would refuse first).
    const s = await seedSkippedStop("latch", { secondStop: true });
    await setStopStatus(s.stopId, "PENDING");

    let armed = true;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let reachedPause!: () => void;
    const paused = new Promise<void>((r) => (reachedPause = r));
    const realForTenant = prisma.forTenant.bind(prisma);
    const spy = jest.spyOn(prisma, "forTenant").mockImplementation(() => {
      const client = realForTenant();
      return new Proxy(client, {
        get(target, prop) {
          const value = Reflect.get(target, prop);
          if (prop !== "routeRun" || !armed) return value;
          return new Proxy(value, {
            get(delegate, method) {
              const fn = Reflect.get(delegate, method);
              if (method !== "findFirst" || !armed) return fn;
              return async (...args: unknown[]) => {
                armed = false; // one pause only — the skip's run read
                // F2 (#2511 @d7ca35c5): read the run FIRST, then hold. Holding before the read let
                // the single-stop fixture's completion also complete the RUN, so the skip was
                // refused by the run guard ("completed run") on both codes and never reached the
                // CAS. With the run already read as IN_PROGRESS, the skip goes on to its write.
                const result = await Reflect.apply(fn, delegate, args);
                reachedPause();
                await gate;
                return result;
              };
            },
          });
        },
      });
    });
    try {
      const skip = tenantCtx.run(s.tenantId, () =>
        routesService.updateStopStatus(s.runId, s.stopId, { status: "SKIPPED" }, operator),
      );
      await paused; // the skip has read the stop as PENDING and is held
      await tenantCtx.run(s.tenantId, () =>
        routesService.completeWithPayment(s.runId, s.stopId, { deliveries: [] } as never, operator),
      );
      expect((await prisma.routeRunStop.findUnique({ where: { id: s.stopId } }))?.status).toBe(
        "COMPLETED",
      );
      release();
      await expect(skip).rejects.toMatchObject({
        response: expect.objectContaining({ code: "STOP_ALREADY_COMPLETED" }),
      });
      // The completion survives: never COMPLETED → SKIPPED.
      expect((await prisma.routeRunStop.findUnique({ where: { id: s.stopId } }))?.status).toBe(
        "COMPLETED",
      );
    } finally {
      release?.();
      spy.mockRestore();
    }
  });

  it("#2514 ONE-STOP (SA-533e): the LAST stop's completion also completes the run while the paused skip waits → 409 STOP_ALREADY_COMPLETED at the stop (never the run guard, never 40P01)", async () => {
    // F2 (#938): the concurrent race above never produced the B707 interleave — the quick skip
    // always committed before completeWithPayment's long tx reached its claim. This latch forces
    // it: updateStopStatus reads the stop (PENDING), then reads the run via
    // forTenant().routeRun.findFirst — the pause point (AFTER that read), identical in the pre-#2415 code, so this
    // pin is RED on the old check-then-update (the skip overwrites COMPLETED with SKIPPED).
    // SA-533e: ONE stop — completing it auto-completes the run (RF-016). In the house order (stop
    // CAS FIRST, then the run lock) the skip still loses at the STOP, never to the run guard; the
    // SA-533 run-first order refused here with the run 409 and could deadlock against completion.
    const s = await seedSkippedStop("latch-one");
    await setStopStatus(s.stopId, "PENDING");

    let armed = true;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let reachedPause!: () => void;
    const paused = new Promise<void>((r) => (reachedPause = r));
    const realForTenant = prisma.forTenant.bind(prisma);
    const spy = jest.spyOn(prisma, "forTenant").mockImplementation(() => {
      const client = realForTenant();
      return new Proxy(client, {
        get(target, prop) {
          const value = Reflect.get(target, prop);
          if (prop !== "routeRun" || !armed) return value;
          return new Proxy(value, {
            get(delegate, method) {
              const fn = Reflect.get(delegate, method);
              if (method !== "findFirst" || !armed) return fn;
              return async (...args: unknown[]) => {
                armed = false; // one pause only — the skip's run read
                // F2 (#2511 @d7ca35c5): read the run FIRST, then hold. Holding before the read let
                // the single-stop fixture's completion also complete the RUN, so the skip was
                // refused by the run guard ("completed run") on both codes and never reached the
                // CAS. With the run already read as IN_PROGRESS, the skip goes on to its write.
                const result = await Reflect.apply(fn, delegate, args);
                reachedPause();
                await gate;
                return result;
              };
            },
          });
        },
      });
    });
    try {
      const skip = tenantCtx.run(s.tenantId, () =>
        routesService.updateStopStatus(s.runId, s.stopId, { status: "SKIPPED" }, operator),
      );
      await paused; // the skip has read the stop as PENDING and is held
      await tenantCtx.run(s.tenantId, () =>
        routesService.completeWithPayment(s.runId, s.stopId, { deliveries: [] } as never, operator),
      );
      expect((await prisma.routeRunStop.findUnique({ where: { id: s.stopId } }))?.status).toBe(
        "COMPLETED",
      );
      release();
      await expect(skip).rejects.toMatchObject({
        response: expect.objectContaining({ code: "STOP_ALREADY_COMPLETED" }),
      });
      // The completion survives: never COMPLETED → SKIPPED.
      expect((await prisma.routeRunStop.findUnique({ where: { id: s.stopId } }))?.status).toBe(
        "COMPLETED",
      );
    } finally {
      release?.();
      spy.mockRestore();
    }
  });

  it("#2514 ONE-STOP race (SA-533e): N rounds of skip vs completing the LAST stop — never a deadlock or 500, one winner", async () => {
    for (let round = 0; round < 8; round++) {
      const s = await seedSkippedStop(`race-one${round}`);
      await setStopStatus(s.stopId, "PENDING");
      const [complete, skip] = await Promise.allSettled([
        tenantCtx.run(s.tenantId, () =>
          routesService.completeWithPayment(
            s.runId,
            s.stopId,
            { deliveries: [] } as never,
            operator,
          ),
        ),
        tenantCtx.run(s.tenantId, () =>
          routesService.updateStopStatus(s.runId, s.stopId, { status: "SKIPPED" }, operator),
        ),
      ]);
      // No deadlock (Postgres 40P01 / Prisma P2034) and no un-mapped 500: every loser is a 409.
      for (const r of [complete, skip]) {
        if (r.status !== "rejected") continue;
        const e = r.reason as any;
        expect(String(e?.code ?? "")).not.toMatch(/P2034|40P01/);
        expect(JSON.stringify(e?.meta ?? {})).not.toMatch(/40P01|deadlock/i);
        expect(e?.getStatus?.()).toBe(409);
      }
      expect(complete.status === "fulfilled" && skip.status === "fulfilled").toBe(false);
      const after = await prisma.routeRunStop.findUnique({ where: { id: s.stopId } });
      if (after?.status === "COMPLETED") {
        expect(skip.status).toBe("rejected");
        expect(isSkipLostToCompletion((skip as PromiseRejectedResult).reason)).toBe(true);
      } else {
        expect(after?.status).toBe("SKIPPED");
        expect(complete.status).toBe("rejected");
      }
    }
  });

  it("#2514 DETERMINISTIC run-latch (SA-533e order): the run COMPLETES while the PATCH waits on the run lock → 409, the stop CAS rolled back", async () => {
    // updateStopStatus is paused after its pre-lock run read (IN_PROGRESS). A second transaction
    // then marks the run COMPLETED and HOLDS the run row lock. The PATCH resumes: its stop CAS
    // (house order, stop FIRST) succeeds, then it blocks on `RouteRun FOR UPDATE`; once the run
    // transaction commits, the PATCH re-reads the run under the lock and refuses — the throw rolls
    // its stop CAS back. RED on the pre-#2514 code: no run lock, so the stop was written.
    // Two stops (SA-533e): the second stays PENDING. Stop B's own completion cannot auto-complete
    // the run while stop A is open (RF-016 needs every stop done), so a held terminal UPDATE on the
    // run is the actor that "completes the run while the PATCH waits".
    const s = await seedSkippedStop("run-latch", { secondStop: true });
    await setStopStatus(s.stopId, "PENDING");

    let armed = true;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let reachedPause!: () => void;
    const paused = new Promise<void>((r) => (reachedPause = r));
    const realForTenant = prisma.forTenant.bind(prisma);
    const spy = jest.spyOn(prisma, "forTenant").mockImplementation(() => {
      const client = realForTenant();
      return new Proxy(client, {
        get(target, prop) {
          const value = Reflect.get(target, prop);
          if (prop !== "routeRun" || !armed) return value;
          return new Proxy(value, {
            get(delegate, method) {
              const fn = Reflect.get(delegate, method);
              if (method !== "findFirst" || !armed) return fn;
              return async (...args: unknown[]) => {
                armed = false;
                const result = await Reflect.apply(fn, delegate, args);
                reachedPause();
                await gate;
                return result;
              };
            },
          });
        },
      });
    });
    let commitRun!: () => void;
    const holdRun = new Promise<void>((r) => (commitRun = r));
    let locked!: () => void;
    const runLocked = new Promise<void>((r) => (locked = r));
    try {
      const patch = tenantCtx.run(s.tenantId, () =>
        routesService.updateStopStatus(s.runId, s.stopId, { status: "SKIPPED" }, operator),
      );
      await paused; // the PATCH read the run as IN_PROGRESS and is held
      const terminal = prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`UPDATE "RouteRun" SET status = 'COMPLETED' WHERE id = ${s.runId}`;
          locked();
          await holdRun;
        },
        { timeout: 30_000 },
      );
      await runLocked;
      release(); // the PATCH resumes and must now wait on the run row lock
      await new Promise((r) => setTimeout(r, 300));
      commitRun();
      await terminal;
      await expect(patch).rejects.toMatchObject({ status: 409 });
      await expect(patch).rejects.toThrow(/completed run/);
      expect((await prisma.routeRunStop.findUnique({ where: { id: s.stopId } }))?.status).toBe(
        "PENDING",
      );
    } finally {
      release?.();
      commitRun?.();
      spy.mockRestore();
    }
  });

  // ─── #2631 / SA-550: the STOP row serializes a run's terminal transition with a completion ────────

  /** Resolves once any lock request in this (throwaway, serial-lane) database is waiting. */
  async function untilSomeoneBlocks(): Promise<boolean> {
    for (let i = 0; i < 200; i++) {
      const rows: Array<{ n: number }> = await prisma.$queryRaw`
        SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted`;
      if (rows[0].n > 0) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  }

  it.each(["completeStop", "completeWithPayment"] as const)(
    "#2631 %s: the run is CANCELLED (stop-first order) while the completion waits on its stop ⇒ 403, nothing written",
    async (method) => {
      // Two stops: completing stop A cannot auto-complete the run, so the only actor that ends the
      // run is the held terminal transaction below, in the NEW house order (stops FOR UPDATE, then run).
      const s = await seedSkippedStop(`2631-latch-${method}`, { secondStop: true });
      await setStopStatus(s.stopId, "PENDING");
      let commitCancel!: () => void;
      const hold = new Promise<void>((r) => (commitCancel = r));
      let locked!: () => void;
      const stopsLocked = new Promise<void>((r) => (locked = r));
      const cancel = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM "RouteRunStop" WHERE "routeRunId" = ${s.runId} ORDER BY id FOR UPDATE`;
          await tx.$executeRaw`UPDATE "RouteRun" SET status = 'CANCELLED' WHERE id = ${s.runId}`;
          locked();
          await hold;
        },
        { timeout: 30_000 },
      );
      try {
        await stopsLocked;
        // The completion's pre-tx reads still see IN_PROGRESS (the cancel is uncommitted); it then
        // blocks on its stop claim, held by the cancel.
        const completion = tenantCtx.run(s.tenantId, () =>
          (routesService as any)[method](s.runId, s.stopId, {}, operator),
        );
        expect(await untilSomeoneBlocks()).toBe(true);
        commitCancel();
        await cancel;
        const err = await completion.catch((e: unknown) => e);
        // RED pre-#2631: no in-tx re-check, so the stop was completed on a cancelled run.
        expect((err as any)?.status).toBe(403);
        expect((err as Error).message).toMatch(/not in progress \(current status: CANCELLED\)/);
        expect((await prisma.routeRunStop.findUnique({ where: { id: s.stopId } }))?.status).toBe(
          "PENDING",
        );
        await expectNothingWritten(s);
      } finally {
        commitCancel?.();
        await cancel.catch(() => undefined);
      }
    },
  );

  it("#2631 pg_locks: the REAL cancel blocked behind an in-flight completion's stop holds NO RouteRun lock", async () => {
    const s = await seedSkippedStop("2631-locks", { secondStop: true });
    await setStopStatus(s.stopId, "PENDING");
    let releaseStop!: () => void;
    const hold = new Promise<void>((r) => (releaseStop = r));
    let held!: () => void;
    const stopHeld = new Promise<void>((r) => (held = r));
    // T1 stands in for a completion that has claimed stop A (holds its row lock).
    const t1 = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "RouteRunStop" WHERE id = ${s.stopId} FOR UPDATE`;
        held();
        await hold;
      },
      { timeout: 30_000 },
    );
    try {
      await stopHeld;
      const cancel = tenantCtx.run(s.tenantId, () =>
        routesService.updateRunStatus(s.runId, { status: "CANCELLED" } as any, operator),
      );
      // RED pre-#2631: the cancel took no stop lock, so it never blocked here.
      expect(await untilSomeoneBlocks()).toBe(true);
      // While the cancel waits on the stop row, the RUN row must be free (no RouteRun edge held).
      const probe = await prisma
        .$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM "RouteRun" WHERE id = ${s.runId} FOR UPDATE NOWAIT`;
          return "free";
        })
        .catch((e: any) => e?.meta?.code ?? e?.code ?? String(e));
      expect(probe).toBe("free");
      releaseStop();
      await t1;
      await cancel;
      expect((await prisma.routeRun.findUnique({ where: { id: s.runId } }))?.status).toBe(
        "CANCELLED",
      );
    } finally {
      releaseStop?.();
      await t1.catch(() => undefined);
    }
  });

  it("#2631 cancel × completion ×6: never a 40P01 under contention — regression guard, not a discriminator", async () => {
    for (let round = 0; round < 6; round++) {
      // eslint-disable-next-line no-await-in-loop
      const s = await seedSkippedStop(`2631-race-${round}`, { secondStop: true });
      // eslint-disable-next-line no-await-in-loop
      await setStopStatus(s.stopId, "PENDING");
      const results = await Promise.allSettled([
        tenantCtx.run(s.tenantId, () =>
          routesService.completeStop(s.runId, s.stopId, {} as any, operator),
        ),
        tenantCtx.run(s.tenantId, () =>
          routesService.updateRunStatus(s.runId, { status: "CANCELLED" } as any, operator),
        ),
      ]);
      for (const r of results) {
        if (r.status === "fulfilled") continue;
        const e: any = r.reason;
        const code = e?.meta?.code ?? e?.code ?? e?.cause?.originalCode;
        expect({ round, code }).not.toEqual({ round, code: "40P01" });
        expect({ round, code }).not.toEqual({ round, code: "P2034" });
        // Only the defined refusal may lose the race: the completion's 403 (the run ended first).
        expect({ round, status: e?.status }).toEqual({ round, status: 403 });
      }
    }
  });
});
